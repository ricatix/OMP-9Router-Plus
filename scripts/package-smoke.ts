// allow: SIZE_OK - task 9 pins one package artifact proof entry that owns
// packing, contents inspection, installed-artifact startup, and cleanup.
/**
 * Distributable package smoke entry for task 9.
 *
 * The script packs the built package with Bun, inspects the real tarball
 * contents, extracts it into a temporary installed package root (no source
 * symlink), and loads the `omp.extensions` entry through the native host that
 * comes from the copied dependency graph. A loopback router captures the
 * discovery and completion requests, and the child session proves an explicit
 * prefixed model can be selected and prompted.
 *
 * The script is also its own child process (`PACKAGE_SMOKE_CHILD=1`), which
 * keeps the host import inside an isolated HOME/cwd before any host module
 * loads. Negative controls live in `tests/package.test.ts`.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Extension } from "@oh-my-pi/pi-coding-agent";
import {
  type FakeRouter,
  type FakeRouterCall,
  startFakeRouter,
} from "../tests/fixtures/fake-router.js";

type HostModule = typeof import("@oh-my-pi/pi-coding-agent");

const repoRoot = resolve(import.meta.dir, "..");
const scriptPath = resolve(import.meta.path);
const packageName = "omp-9router-plus";
const childFlag = "PACKAGE_SMOKE_CHILD";
const requestFlag = "PACKAGE_SMOKE_REQUEST";
const defaultEvidenceDir = join(".omo", "evidence", "omp-9router-plus");
const catalogSpecifier = "@oh-my-pi/pi-catalog/effort";
const fixtureBearer = "package-smoke-bearer";

const requiredEntries = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/NOTICE",
  "package/dist/index.js",
  "package/dist/generated/9router-llm-catalog.js",
] as const;

const roster = [
  {
    id: "cx/test-model",
    kind: "llm",
    name: "CX Test Model",
    capabilities: {
      reasoning: true,
      tools: false,
      vision: false,
      contextWindow: 65_536,
      maxOutput: 8_192,
    },
  },
] as const;

export interface PackArtifact {
  readonly tarball: string;
  readonly entries: readonly string[];
  readonly bytes: number;
  readonly sha256: string;
}

export interface PackageInspection {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly forbidden: readonly string[];
}

export interface InstalledPackage {
  readonly installRoot: string;
  readonly packageDir: string;
  readonly packageJson: Record<string, unknown>;
}

export interface PackagedChildRequest {
  readonly installRoot: string;
  readonly entry: string;
  readonly agentDir: string;
  readonly workDir: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly modelsPath: string;
  readonly resultPath: string;
}

export interface SerializedModel {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
  readonly input: readonly string[];
  readonly supportsTools?: boolean;
  readonly reasoning: boolean;
}

export interface PackagedChildResult {
  readonly ok: true;
  readonly kind: "packaged-session";
  readonly versions: { readonly bun: string; readonly host: string };
  readonly process: { readonly pid: number; readonly cwd: string };
  readonly extension: {
    readonly path: string;
    readonly resolvedPath: string;
    readonly registersProviders: boolean;
  } | null;
  readonly loadErrors: readonly {
    readonly path: string;
    readonly message: string;
  }[];
  readonly roster: readonly SerializedModel[];
  readonly selection: {
    readonly provider: string;
    readonly id: string;
  } | null;
  readonly before: {
    readonly provider: string;
    readonly id: string;
  } | null;
  readonly after: {
    readonly provider: string;
    readonly id: string;
  } | null;
  readonly prompt: {
    readonly attempted: boolean;
    readonly result: boolean;
  } | null;
  readonly network: {
    readonly policy: "loopback-only-guard";
    readonly rejectedExternalCalls: number;
    readonly rejectedOrigins: readonly string[];
  };
}

interface ChildFailure {
  readonly ok: false;
  readonly error: string;
  readonly stack?: string;
}

export interface PackagedChildOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: PackagedChildResult | ChildFailure | null;
  readonly pid: number;
  readonly exited: boolean;
}

export async function packProject(destination: string): Promise<PackArtifact> {
  await mkdir(destination, { recursive: true });
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "pm",
      "pack",
      "--ignore-scripts",
      "--destination",
      destination,
    ],
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [_stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`bun pm pack failed (exit ${exitCode}): ${stderr}`);
  const names = (await readdir(destination)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (names.length !== 1)
    throw new Error(
      `bun pm pack produced ${names.length} tarballs: ${names.join(", ")}`,
    );
  const tarball = join(destination, names[0] as string);
  const entries = await listTarballEntries(tarball);
  const bytes = await Bun.file(tarball).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return {
    tarball,
    entries,
    bytes: bytes.byteLength,
    sha256: hasher.digest("hex"),
  };
}

export async function listTarballEntries(
  tarball: string,
): Promise<readonly string[]> {
  const proc = Bun.spawn({
    cmd: ["tar", "-tzf", tarball],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`tar -tzf failed (exit ${exitCode}): ${stderr}`);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function inspectPackageEntries(
  entries: readonly string[],
): PackageInspection {
  const errors: string[] = [];
  const forbidden: string[] = [];
  for (const required of requiredEntries)
    if (!entries.includes(required))
      errors.push(`missing required artifact entry: ${required}`);
  for (const entry of entries) {
    const reason = forbiddenEntryReason(entry);
    if (reason === null) continue;
    forbidden.push(`${entry} (${reason})`);
    errors.push(`forbidden artifact entry: ${entry} (${reason})`);
  }
  return { ok: errors.length === 0, errors, forbidden };
}

function forbiddenEntryReason(entry: string): string | null {
  const segments = entry.split("/");
  if (isAbsolute(entry)) return "absolute path";
  if (segments.includes(".omo")) return "local plan/evidence";
  if (segments.includes("node_modules")) return "bundled dependency tree";
  if (segments.includes("tests")) return "source tests";
  if (segments.includes(".git")) return "git metadata";
  if (segments.includes("cache")) return "cache directory";
  if (
    segments.some(
      (segment) => segment === ".env" || segment.startsWith(".env."),
    )
  )
    return "environment file";
  if (entry.endsWith(".log")) return "log file";
  if (entry.endsWith(".map")) return "source map";
  if (entry.endsWith(".DS_Store")) return "OS metadata";
  return null;
}

export async function extractInstalledPackage(
  tarball: string,
  installRoot: string,
): Promise<InstalledPackage> {
  const staging = join(installRoot, ".extract");
  await mkdir(staging, { recursive: true });
  const proc = Bun.spawn({
    cmd: ["tar", "-xzf", tarball, "-C", staging],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`tar -xzf failed (exit ${exitCode}): ${stderr}`);
  const staged = join(staging, "package");
  const packageJson = (await Bun.file(
    join(staged, "package.json"),
  ).json()) as Record<string, unknown>;
  if (packageJson.name !== packageName)
    throw new Error(
      `unexpected artifact package name: ${String(packageJson.name)}`,
    );
  const packageDir = join(installRoot, "node_modules", packageName);
  await rm(packageDir, { recursive: true, force: true });
  await rename(staged, packageDir);
  await rm(staging, { recursive: true, force: true });
  return { installRoot, packageDir, packageJson };
}

export async function copyHostDependencyGraph(
  installRoot: string,
): Promise<void> {
  const source = join(repoRoot, "node_modules");
  const target = join(installRoot, "node_modules");
  await mkdir(target, { recursive: true });
  const args =
    process.platform === "darwin"
      ? ["-cR", `${source}/.`, target]
      : ["-R", `${source}/.`, target];
  const proc = Bun.spawn({
    cmd: ["cp", ...args],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`copying the host dependency graph failed: ${stderr}`);
}

export async function resolveOmpExtensionEntry(
  packageDir: string,
  packageJson: Record<string, unknown>,
): Promise<string> {
  const omp = packageJson.omp;
  if (typeof omp !== "object" || omp === null)
    throw new Error("artifact package.json has no omp manifest");
  const extensions = (omp as { extensions?: unknown }).extensions;
  if (!Array.isArray(extensions) || extensions.length !== 1)
    throw new Error("artifact omp.extensions must contain exactly one entry");
  const value = extensions[0];
  if (typeof value !== "string" || value.length === 0)
    throw new Error("artifact omp.extensions entry is not a nonempty string");
  if (isAbsolute(value) || value.split("/").includes(".."))
    throw new Error(
      `artifact omp.extensions entry escapes the package: ${value}`,
    );
  const entry = resolve(packageDir, value);
  if (!isInside(packageDir, entry))
    throw new Error(
      `artifact omp.extensions entry escapes the package: ${value}`,
    );
  const entryStat = await lstat(entry);
  if (entryStat.isSymbolicLink())
    throw new Error("artifact omp.extensions entry is a symbolic link");
  if (!entryStat.isFile())
    throw new Error("artifact omp.extensions entry is not a regular file");
  return entry;
}

export async function proveCatalogResolution(
  entry: string,
  installRoot: string,
): Promise<{
  readonly specifier: string;
  readonly resolvedPath: string;
  readonly insideInstall: boolean;
}> {
  const resolvedPath = Bun.resolveSync(catalogSpecifier, dirname(entry));
  const realInstall = await realpath(installRoot);
  const realResolved = await realpath(resolvedPath);
  return {
    specifier: catalogSpecifier,
    resolvedPath,
    insideInstall: isInside(realInstall, realResolved),
  };
}

export async function findSourcePathReferences(
  packageDir: string,
  needles: readonly string[],
): Promise<readonly string[]> {
  const hits: string[] = [];
  const textExtensions = new Set([".js", ".ts", ".json", ".md"]);
  for (const path of await walkFiles(packageDir)) {
    if (!textExtensions.has(extname(path))) continue;
    const text = await readFile(path, "utf8");
    for (const needle of needles)
      if (needle.length > 0 && text.includes(needle)) {
        hits.push(`${relative(packageDir, path)} contains ${needle}`);
        break;
      }
  }
  return hits;
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

export async function runPackagedChild(
  request: PackagedChildRequest,
  timeoutMs = 120_000,
): Promise<PackagedChildOutcome> {
  const requestPath = join(dirname(request.resultPath), "child-request.json");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const env = childEnvironment(request);
  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath],
    cwd: request.workDir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
  let result: PackagedChildResult | ChildFailure | null = null;
  try {
    result = (await Bun.file(request.resultPath).json()) as
      | PackagedChildResult
      | ChildFailure;
  } catch {
    result = null;
  }
  return {
    exitCode,
    stdout,
    stderr,
    result,
    pid: proc.pid,
    exited: proc.exitCode !== null,
  };
}

function childEnvironment(
  request: PackagedChildRequest,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  for (const key of [
    "OMP_PROFILE",
    "PI_PROFILE",
    "OPENCODE_CONFIG_DIR",
    "NINE_ROUTER_API_KEY",
    "OTHER_KEY",
  ])
    delete env[key];
  env.HOME = request.homeDir;
  env.PI_CODING_AGENT_DIR = request.agentDir;
  env.XDG_CACHE_HOME = join(request.homeDir, ".cache");
  env.XDG_CONFIG_HOME = join(request.homeDir, ".config");
  env.XDG_DATA_HOME = join(request.homeDir, ".local", "share");
  env.XDG_STATE_HOME = join(request.homeDir, ".local", "state");
  env.TMPDIR = request.tmpDir;
  env.DO_NOT_TRACK = "1";
  env.OMP_DISABLE_TELEMETRY = "1";
  env[childFlag] = "1";
  env[requestFlag] = join(dirname(request.resultPath), "child-request.json");
  env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;
  return env;
}

async function runChildMode(): Promise<never> {
  const requestPath = process.env[requestFlag];
  let resultPath: string | undefined;
  try {
    if (requestPath === undefined)
      throw new Error(`${requestFlag} is required`);
    const request = (await Bun.file(
      requestPath,
    ).json()) as PackagedChildRequest;
    resultPath = request.resultPath;
    const result = await runPackagedSession(request);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    const failure: ChildFailure = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    if (resultPath !== undefined)
      await writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`);
    process.exit(1);
  }
}

async function runPackagedSession(
  request: PackagedChildRequest,
): Promise<PackagedChildResult> {
  const guard = installLoopbackGuard();
  const installRoot = await realpath(request.installRoot);
  const hostEntry = await resolveInsideInstall(
    installRoot,
    Bun.resolveSync("@oh-my-pi/pi-coding-agent", installRoot),
  );
  const storageEntry = await resolveInsideInstall(
    installRoot,
    Bun.resolveSync(
      "@oh-my-pi/pi-coding-agent/session/agent-storage",
      installRoot,
    ),
  );
  const eventBusEntry = await resolveInsideInstall(
    installRoot,
    Bun.resolveSync("@oh-my-pi/pi-coding-agent/utils/event-bus", installRoot),
  );
  const host = (await import(hostEntry)) as HostModule;
  const { AgentStorage } = await import(storageEntry);
  const { EventBus } = await import(eventBusEntry);
  const storage = await AgentStorage.open(join(request.agentDir, "agent.db"));
  try {
    const settings = host.Settings.isolated({}, { storage });
    const authStorage = await host.discoverAuthStorage(request.agentDir, {
      settings,
    });
    const registry = new host.ModelRegistry(authStorage, request.modelsPath, {
      cacheDbPath: join(request.agentDir, "models.db"),
    });
    const loaded = await host.loadSessionExtensions(
      {
        additionalExtensionPaths: [request.entry],
        disableExtensionDiscovery: true,
      },
      request.workDir,
      settings,
      new EventBus(),
    );
    const sessionResult = await host.createAgentSession({
      cwd: request.workDir,
      agentDir: request.agentDir,
      settings,
      authStorage,
      modelRegistry: registry,
      modelPattern: "9router/cx/test-model",
      toolNames: [],
      preloadedExtensions: loaded,
      additionalExtensionPaths: [request.entry],
      disableExtensionDiscovery: true,
      noContextFiles: true,
      excludeAgentsMd: true,
      enableMCP: false,
      enableLsp: false,
      autoTitle: false,
      cacheWarming: false,
      systemPrompt: "task9 package fixture",
    });
    const loadErrors = sessionResult.extensionsResult.errors.map((entry) => ({
      path: entry.path,
      message: String(entry.error),
    }));
    const extension: Extension | undefined =
      sessionResult.extensionsResult.extensions.find(
        (item) => resolve(item.resolvedPath) === resolve(request.entry),
      );
    if (loadErrors.length > 0)
      throw new Error(
        `packaged extension failed to load: ${loadErrors
          .map((entry) => entry.message)
          .join("; ")}`,
      );
    if (extension === undefined)
      throw new Error(
        `packaged extension entry was not loaded: ${request.entry}`,
      );
    const roster = registry.getProviderModels("9router");
    if (roster.length === 0)
      throw new Error("packaged startup registered no 9router models");
    const before = selectionOf(sessionResult.session);
    const promptResult = await sessionResult.session.prompt("packaged smoke");
    const after = selectionOf(sessionResult.session);
    const selection = registry.find("9router", "cx/test-model");
    const result: PackagedChildResult = {
      ok: true,
      kind: "packaged-session",
      versions: { bun: Bun.version, host: host.VERSION },
      process: { pid: process.pid, cwd: process.cwd() },
      extension: {
        path: extension.path,
        resolvedPath: extension.resolvedPath,
        registersProviders: extension.registersProviders === true,
      },
      loadErrors,
      roster: roster.map(serializeModel),
      selection: selection
        ? { provider: selection.provider, id: selection.id }
        : null,
      before,
      after,
      prompt: { attempted: true, result: promptResult },
      network: {
        policy: "loopback-only-guard",
        rejectedExternalCalls: guard.rejectedExternalCalls(),
        rejectedOrigins: guard.rejectedOrigins(),
      },
    };
    await sessionResult.session.dispose();
    return result;
  } finally {
    AgentStorage.close();
  }
}

async function resolveInsideInstall(
  installRoot: string,
  candidate: string,
): Promise<string> {
  const realCandidate = await realpath(candidate);
  if (!isInside(installRoot, realCandidate))
    throw new Error(
      `runtime resolution escaped the installed artifact: ${candidate}`,
    );
  return realCandidate;
}

function selectionOf(session: {
  readonly model:
    | { readonly provider: string; readonly id: string }
    | undefined;
}): { readonly provider: string; readonly id: string } | null {
  return session.model
    ? { provider: session.model.provider, id: session.model.id }
    : null;
}

function serializeModel(model: {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
  readonly input: readonly string[];
  readonly supportsTools?: boolean;
  readonly reasoning: boolean;
}): SerializedModel {
  return {
    id: model.id,
    provider: model.provider,
    api: model.api,
    input: [...model.input],
    supportsTools: model.supportsTools,
    reasoning: model.reasoning,
  };
}

function installLoopbackGuard(): {
  readonly rejectedExternalCalls: () => number;
  readonly rejectedOrigins: () => readonly string[];
} {
  let rejectedExternalCalls = 0;
  const rejectedOrigins = new Set<string>();
  const nativeFetch = globalThis.fetch;
  const guardedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return await nativeFetch(input, init);
    }
    if (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    )
      return await nativeFetch(input, init);
    rejectedExternalCalls++;
    rejectedOrigins.add(url.origin);
    throw new Error("package smoke forbids non-loopback fetch");
  };
  globalThis.fetch = Object.assign(guardedFetch, {
    preconnect: () => undefined,
  });
  return {
    rejectedExternalCalls: () => rejectedExternalCalls,
    rejectedOrigins: () => [...rejectedOrigins],
  };
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation.length > 0 && !relation.startsWith(`..${sep}`) && relation !== ".."
  );
}

async function prepareFixture(
  root: string,
  installRoot: string,
  entry: string,
  server: FakeRouter,
): Promise<PackagedChildRequest> {
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const workDir = join(root, "work");
  const tmpDir = join(root, "tmp");
  for (const item of [homeDir, agentDir, workDir, tmpDir])
    await mkdir(item, { recursive: true });
  const cacheDir = join(homeDir, ".cache", "omp-9router-plus");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "models.dev.api.json"),
    JSON.stringify({ timestamp: Date.now(), data: {} }),
  );
  await writeFile(
    join(cacheDir, "models.dev.models.json"),
    JSON.stringify({ timestamp: Date.now(), data: {} }),
  );
  const modelsPath = join(agentDir, "models.yml");
  await writeFile(
    modelsPath,
    `${[
      "providers:",
      '  "9router":',
      `    baseUrl: ${JSON.stringify(server.nineRouterBaseUrl)}`,
      "    api: openai-completions",
      `    apiKey: "${fixtureBearer}"`,
    ].join("\n")}\n`,
  );
  return {
    installRoot,
    entry,
    agentDir,
    workDir,
    homeDir,
    tmpDir,
    modelsPath,
    resultPath: join(root, "child-result.json"),
  };
}

function evidenceDirectory(argv: readonly string[]): string {
  const index = argv.indexOf("--evidence-dir");
  const inline = argv.find((arg) => arg.startsWith("--evidence-dir="));
  const configured =
    inline !== undefined
      ? inline.slice("--evidence-dir=".length)
      : index >= 0
        ? argv[index + 1]
        : process.env.EVIDENCE_DIR;
  const value = configured ?? defaultEvidenceDir;
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

async function main(): Promise<number> {
  const evidenceDir = evidenceDirectory(process.argv.slice(2));
  await mkdir(evidenceDir, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "omp-package-smoke-"));
  const installRoot = join(root, "install");
  let server: FakeRouter | undefined;
  let child: PackagedChildOutcome | undefined;
  const evidence: Record<string, unknown> = {
    planTask: 9,
    generatedAt: new Date().toISOString(),
    status: "failed",
  };
  try {
    if (!(await Bun.file(join(repoRoot, "dist", "index.js")).exists()))
      throw new Error(
        "dist/index.js is missing. Run `bun run build` before the package smoke.",
      );
    const artifact = await packProject(join(root, "pack"));
    const inspection = inspectPackageEntries(artifact.entries);
    if (!inspection.ok)
      throw new Error(
        `artifact inspection failed: ${inspection.errors.join("; ")}`,
      );
    await mkdir(installRoot, { recursive: true });
    await copyHostDependencyGraph(installRoot);
    const installed = await extractInstalledPackage(
      artifact.tarball,
      installRoot,
    );
    const entry = await resolveOmpExtensionEntry(
      installed.packageDir,
      installed.packageJson,
    );
    const resolution = await proveCatalogResolution(entry, installRoot);
    if (!resolution.insideInstall)
      throw new Error(
        `${catalogSpecifier} resolved outside the installed artifact: ${resolution.resolvedPath}`,
      );
    const sourceHits = await findSourcePathReferences(installed.packageDir, [
      await realpath(repoRoot),
      "/private/var/folders/",
    ]);
    if (sourceHits.length > 0)
      throw new Error(`artifact leaks source paths: ${sourceHits.join("; ")}`);

    server = startFakeRouter({ roster });
    const request = await prepareFixture(root, installRoot, entry, server);
    child = await runPackagedChild(request);
    const childResult = child.result;
    if (
      child.exitCode !== 0 ||
      childResult === null ||
      childResult.ok !== true
    ) {
      const message =
        childResult !== null && "error" in childResult
          ? childResult.error
          : "child produced no result";
      throw new Error(
        `packaged startup failed (exit ${child.exitCode}): ${message}\n${child.stderr}`,
      );
    }
    assertStartup(childResult, entry);
    const wire = assertWire(server, childResult);
    const regressions = await runPackageRegressions(evidenceDir);
    if (!regressions.ok)
      throw new Error(
        `package regressions failed (exit ${regressions.exitCode}); see ${regressions.log}`,
      );

    evidence.status = "passed";
    evidence.regressions = regressions;
    evidence.versions = childResult.versions;
    evidence.artifact = {
      filename: artifact.tarball.split("/").pop() ?? artifact.tarball,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      entries: artifact.entries,
    };
    evidence.contents = {
      inspectedEntries: artifact.entries.length,
      requiredPresent: requiredEntries.filter((name) =>
        artifact.entries.includes(name),
      ),
      forbiddenEntries: inspection.forbidden,
      sourcePathReferences: sourceHits,
    };
    evidence.installation = {
      entry: relative(installed.packageDir, entry),
      entryIsSymlink: false,
      packageDir: installed.packageDir,
      insideTempRoot: isInside(
        await realpath(root),
        await realpath(installed.packageDir),
      ),
    };
    evidence.runtimeResolution = resolution;
    evidence.startup = {
      extension: childResult.extension,
      roster: childResult.roster,
      selection: childResult.selection,
      before: childResult.before,
      after: childResult.after,
      prompt: childResult.prompt,
      loadErrors: childResult.loadErrors,
      network: childResult.network,
      versions: childResult.versions,
    };
    evidence.wire = wire;
    console.log(
      `[package] status=passed entry=${relative(installed.packageDir, entry)} selector=9router/cx/test-model sha256=${artifact.sha256}`,
    );
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error(`[package] status=failed: ${String(evidence.error)}`);
  } finally {
    server?.stop();
    const rootRemoved = await rm(root, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
    evidence.cleanup = {
      root,
      rootRemoved,
      serverStopped: server !== undefined,
      childPids: child ? [child.pid] : [],
      childExited: child?.exited ?? true,
    };
  }
  const summary = {
    planTask: 9,
    generatedAt: evidence.generatedAt,
    status: evidence.status,
    evidence: join(evidenceDir, "task-9-package.json"),
    artifactSha256:
      typeof evidence.artifact === "object" &&
      evidence.artifact !== null &&
      "sha256" in evidence.artifact
        ? (evidence.artifact as { sha256?: unknown }).sha256
        : null,
    cleanup: evidence.cleanup,
  };
  await writeFile(
    join(evidenceDir, "task-9-package.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(
    join(evidenceDir, "task-9-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(`evidence=${join(evidenceDir, "task-9-package.json")}`);
  console.log(`summary=${join(evidenceDir, "task-9-summary.json")}`);
  return evidence.status === "passed" ? 0 : 1;
}

/**
 * Runs the whole package regression file, not only the `broken artifact`
 * subset: artifact contents, extension entry resolution, and the broken
 * controls are all part of the aggregate gate.
 */
async function runPackageRegressions(evidenceDir: string): Promise<{
  readonly ok: boolean;
  readonly exitCode: number;
  readonly log: string;
  readonly testFile: string;
}> {
  const testFile = join(repoRoot, "tests", "package.test.ts");
  const log = join(evidenceDir, "task-13-package-tests.log");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.EVIDENCE_DIR = evidenceDir;
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", testFile],
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 240_000);
  let logText = "";
  let exitCode = 1;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    logText = `${stdout}${stderr}`;
    exitCode = code;
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
  await writeFile(log, logText);
  return { ok: exitCode === 0, exitCode, log, testFile };
}

function assertStartup(result: PackagedChildResult, entry: string): void {
  if (result.loadErrors.length > 0)
    throw new Error(
      `packaged extension reported load errors: ${result.loadErrors
        .map((item) => item.message)
        .join("; ")}`,
    );
  if (
    result.extension === null ||
    resolve(result.extension.resolvedPath) !== resolve(entry)
  )
    throw new Error(
      "packaged extension entry was not loaded from the artifact",
    );
  if (result.roster.length !== 1 || result.roster[0]?.id !== "cx/test-model")
    throw new Error(
      `unexpected packaged roster: ${result.roster.map((model) => model.id).join(", ")}`,
    );
  if (
    result.selection?.provider !== "9router" ||
    result.selection.id !== "cx/test-model"
  )
    throw new Error(
      `explicit prefixed selector did not resolve: ${JSON.stringify(result.selection)}`,
    );
  if (
    result.before?.provider !== "9router" ||
    result.before.id !== "cx/test-model" ||
    result.after?.provider !== "9router" ||
    result.after.id !== "cx/test-model"
  )
    throw new Error("session selection did not stay on the packaged model");
  if (result.prompt?.attempted !== true || result.prompt.result !== true)
    throw new Error("packaged session prompt did not complete");
  if (result.network.rejectedExternalCalls !== 0)
    throw new Error("packaged session attempted a non-loopback request");
}

function assertWire(
  server: FakeRouter,
  result: PackagedChildResult,
): Record<string, unknown> {
  const discovery = server.calls.filter((call) => call.kind === "discovery");
  const completion = server.calls.filter((call) => call.kind === "completion");
  if (discovery.length !== 1)
    throw new Error(`expected one discovery request, saw ${discovery.length}`);
  if (completion.length !== 1)
    throw new Error(
      `expected one completion request, saw ${completion.length}`,
    );
  const discoveryCall = discovery[0] as FakeRouterCall;
  const completionCall = completion[0] as FakeRouterCall;
  if (discoveryCall.authorization !== `Bearer ${fixtureBearer}`)
    throw new Error("discovery did not use the configured bearer fixture");
  if (completionCall.authorization !== `Bearer ${fixtureBearer}`)
    throw new Error("completion did not use the configured bearer fixture");
  if (completionCall.body?.model !== "cx/test-model")
    throw new Error(
      `completion sent an unexpected model: ${String(completionCall.body?.model)}`,
    );
  if (completionCall.body?.stream !== true)
    throw new Error("completion did not request a streaming response");
  return {
    discovery: {
      path: discoveryCall.path,
      authorization: discoveryCall.authorization,
    },
    completion: {
      path: completionCall.path,
      authorization: completionCall.authorization,
      model: completionCall.body?.model,
      stream: completionCall.body?.stream,
    },
    sseConsumed: result.prompt?.result === true,
  };
}

if (import.meta.main) {
  if (process.env[childFlag] === "1") await runChildMode();
  else process.exit(await main());
}
