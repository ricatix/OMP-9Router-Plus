// allow: SIZE_OK - task 11 ships one cohesive host-contract integration file; fixtures and child scenarios are inline by design.
/**
 * Permanent host-contract regression test for the installed
 * `@oh-my-pi/pi-coding-agent` artifact. It proves the startup, roster, and
 * model-authority behavior the 9Router extension will rely on, without
 * patching the host or mocking its registry.
 *
 * Child processes run this same file (top-level dispatch) so every state
 * transition crosses a real process boundary. Network access is disabled in
 * every child; only test-owned fixtures are used.
 */
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type {
  Extension,
  LoadExtensionsResult,
  ProviderConfig,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";

type HostModule = typeof import("@oh-my-pi/pi-coding-agent");
type AgentStorageModule =
  typeof import("@oh-my-pi/pi-coding-agent/session/agent-storage");
type EventBusModule =
  typeof import("@oh-my-pi/pi-coding-agent/utils/event-bus");
type HostRegistry = InstanceType<HostModule["ModelRegistry"]>;
type HostModel = NonNullable<ReturnType<HostRegistry["find"]>>;

type ScenarioMode = "success" | "failure" | "seed" | "conflict";
type RefreshStrategy = "offline" | "online";

interface ScenarioRequest {
  repoRoot: string;
  agentDir: string;
  workDir: string;
  modelsPath: string;
  extensionPath: string;
  rosterPath: string;
  staleRosterPath: string;
  diagnosticPath: string;
  resultPath: string;
  mode: ScenarioMode;
  refreshStrategy: RefreshStrategy;
}

interface SerializedThinking {
  mode?: string;
  efforts?: readonly string[];
  defaultLevel?: string;
  requiresEffort?: boolean;
  unverified?: boolean;
}

interface SerializedModel {
  id: string;
  provider: string;
  name: string;
  api: string;
  baseUrl: string | null;
  reasoning: boolean;
  thinking: SerializedThinking | null;
  input: readonly string[];
  supportsTools?: boolean;
  cost: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  contextWindow: number | null;
  maxTokens: number | null;
  requestModelId?: string;
}

interface SerializedDiagnostic {
  code?: string;
  provider?: string;
  unsupported?: readonly string[];
  message?: string;
  removedUserModels?: boolean;
}

interface ScenarioResult {
  ok: true;
  versions: { host: string; package: string; bun: string };
  process: {
    pid: number;
    cwd: string;
    agentDir: string;
    modelsPath: string;
    cacheDbPath: string;
  };
  network: { policy: "disabled-fetch"; calls: number };
  extension: {
    path: string;
    resolvedPath: string;
    registersProviders: boolean;
  } | null;
  extensions: Array<{
    path: string;
    resolvedPath: string;
    registersProviders: boolean;
  }>;
  deferredPaths: readonly string[];
  loadErrors: LoadExtensionsResult["errors"];
  models9router: SerializedModel[];
  otherModels: SerializedModel[];
  selection: {
    testModel: SerializedModel | null;
    nativeEffort: SerializedModel | null;
    manualModel: SerializedModel | null;
    otherModel: SerializedModel | null;
  };
  hasProvider9router: boolean;
  discoveryState: unknown;
  runtimeDiscoveryFailures: unknown;
  fingerprint: string;
  verdict: { fingerprint?: string; deferrable?: boolean } | null;
  verdictKey: string;
  cacheRows: unknown;
  diagnostic: SerializedDiagnostic | null;
}

interface ChildResult extends ScenarioResult {
  ok: true;
}

interface ChildFailure {
  ok: false;
  error: string;
  stack?: string;
}

// ---------------------------------------------------------------------------
// Host entry typing (types only; the child imports the installed artifact).
// ---------------------------------------------------------------------------

type HostRosterModel = ProviderModelConfig & { supportsTools?: boolean };

type HostPublicModel = HostModel;

// `Effort` is an ambient const enum, so `Effort.Low` breaks under
// `verbatimModuleSyntax`; use the same runtime list the product mapper reads.
const NATIVE_EFFORTS = THINKING_EFFORTS.filter(
  (effort) => effort === "low" || effort === "high",
);

const HOST_CONTRACT_TEST_TOKEN = "host-contract-test-token";
const OTHER_PROVIDER_TOKEN = "other-contract-test-token";
const CHILD_TIMEOUT_MS = 120_000;
// Bun's 5 s default test timeout is shorter than one child watchdog. Parent
// budgets cover the child watchdogs each test awaits plus a 30 s margin:
// 150_000 ms for one child and 510_000 ms for four (CHILD_TIMEOUT_MS each).

/**
 * The roster is intentionally authored as a structurally wider public model:
 * `ProviderModelConfig` does not declare `supportsTools`, while the runtime
 * `ProviderConfigInput` accepts it. Assigning the typed array to
 * `ProviderConfig.models` below is the compile-time proof that the runtime
 * shape is structurally assignable without casts or suppressions.
 */
const ROSTER: HostRosterModel[] = [
  {
    id: "cx/test-model",
    name: "cx/test-model",
    reasoning: true,
    thinking: undefined,
    input: ["text"],
    supportsTools: false,
    compat: { trustExplicitThinkingOnly: true },
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 65_536,
    maxTokens: 8_192,
  },
  {
    id: "cx/unguarded-model",
    name: "cx/unguarded-model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  },
  {
    id: "cx/native-effort",
    name: "cx/native-effort",
    reasoning: true,
    thinking: { mode: "effort", efforts: NATIVE_EFFORTS },
    input: ["text", "image"],
    supportsTools: true,
    cost: { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 0.6 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
];

const PUBLIC_PROVIDER_CONFIG: ProviderConfig = {
  baseUrl: "http://127.0.0.1:20128/v1",
  apiKey: HOST_CONTRACT_TEST_TOKEN,
  api: "openai-completions",
  models: ROSTER,
};

const STALE_ROSTER: HostRosterModel[] = [
  {
    id: "stale/legacy-model",
    name: "stale/legacy-model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  },
];

// ---------------------------------------------------------------------------
// Child dispatch
// ---------------------------------------------------------------------------

const CHILD_ENV = "HOST_CONTRACT_CHILD";
const REQUEST_ENV = "HOST_CONTRACT_REQUEST";

if (process.env[CHILD_ENV] === "1") {
  await runChildEntry();
}

async function runChildEntry(): Promise<never> {
  const requestPath = process.env[REQUEST_ENV];
  let resultPath: string | undefined;
  try {
    if (!requestPath)
      throw new Error(`${REQUEST_ENV} is required in child mode`);
    const request = (await Bun.file(requestPath).json()) as ScenarioRequest;
    resultPath = request.resultPath;
    const result = await runChildScenario(request);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    const failure: ChildFailure = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    if (resultPath)
      await writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`);
    process.exit(1);
  }
}

async function runChildScenario(
  request: ScenarioRequest,
): Promise<ScenarioResult> {
  let networkCalls = 0;
  // Enforce the fixture-only policy at the process boundary. Any host path
  // that tries to reach a real endpoint fails loudly instead of leaking traffic.
  const disabledFetch: typeof fetch = Object.assign(
    (..._args: Parameters<typeof fetch>): Promise<never> => {
      networkCalls++;
      return Promise.reject(
        new Error("host-contract integration test forbids network access"),
      );
    },
    {
      preconnect: (
        _url: string | URL,
        _options?: {
          dns?: boolean;
          tcp?: boolean;
          http?: boolean;
          https?: boolean;
        },
      ): void => {},
    },
  );
  globalThis.fetch = disabledFetch;

  const hostEntry = Bun.resolveSync(
    "@oh-my-pi/pi-coding-agent",
    request.repoRoot,
  );
  const storageEntry = Bun.resolveSync(
    "@oh-my-pi/pi-coding-agent/session/agent-storage",
    request.repoRoot,
  );
  const eventBusEntry = Bun.resolveSync(
    "@oh-my-pi/pi-coding-agent/utils/event-bus",
    request.repoRoot,
  );

  const host: HostModule = await import(hostEntry);
  const { AgentStorage }: AgentStorageModule = await import(storageEntry);
  const { EventBus }: EventBusModule = await import(eventBusEntry);

  const agentDbPath = join(request.agentDir, "agent.db");
  const cacheDbPath = join(request.agentDir, "models.db");
  const storage = await AgentStorage.open(agentDbPath);
  const settings = host.Settings.isolated({}, { storage });
  const authStorage = await host.discoverAuthStorage(request.agentDir, {
    settings,
  });
  const registry = new host.ModelRegistry(authStorage, request.modelsPath, {
    cacheDbPath,
  });

  const extensionsResult = await host.loadSessionExtensions(
    {
      additionalExtensionPaths: [request.extensionPath],
      disableExtensionDiscovery: true,
    },
    request.workDir,
    settings,
    new EventBus(),
    { deferStartupSafe: true },
  );

  // Mirror the host's session/CLI drain order exactly: clear stale extension
  // sources first, then apply this load's queued provider registrations.
  registry.syncExtensionSources(
    extensionsResult.extensions.map((extension) => extension.path),
  );
  registry.clearSourceRegistrations(
    new Set(extensionsResult.extensions.map((extension) => extension.path)),
  );
  for (const registration of extensionsResult.runtime
    .pendingProviderRegistrations) {
    registry.registerProvider(
      registration.name,
      registration.config,
      registration.sourceId,
    );
  }
  extensionsResult.runtime.pendingProviderRegistrations.length = 0;
  await registry.refreshRuntimeProviders(request.refreshStrategy);

  const fingerprint = await fingerprintSource(request.extensionPath);
  const verdictKey = `extension_startup:v2:${resolve(request.extensionPath)}`;
  const rawVerdict = storage.getCache(verdictKey);
  const verdict = rawVerdict
    ? (JSON.parse(rawVerdict) as { fingerprint?: string; deferrable?: boolean })
    : null;
  const models9router = pickModels(registry.getProviderModels("9router"));
  const otherModels = pickModels(registry.getProviderModels("other"));
  const extension = extensionsResult.extensions[0]
    ? extensionSnapshot(extensionsResult.extensions[0])
    : null;
  const diagnostic = await readDiagnostic(request.diagnosticPath);
  const cacheRows = await readCacheRows(cacheDbPath);
  const packageVersion = await readHostPackageVersion(request.repoRoot);

  const result: ScenarioResult = {
    ok: true,
    versions: {
      host: host.VERSION,
      package: packageVersion,
      bun: Bun.version,
    },
    process: {
      pid: process.pid,
      cwd: process.cwd(),
      agentDir: request.agentDir,
      modelsPath: request.modelsPath,
      cacheDbPath,
    },
    network: { policy: "disabled-fetch", calls: networkCalls },
    extension,
    extensions: extensionsResult.extensions.map(extensionSnapshot),
    deferredPaths: extensionsResult.deferredPaths,
    loadErrors: extensionsResult.errors,
    models9router,
    otherModels,
    selection: {
      testModel: pickModel(registry.find("9router", "cx/test-model")),
      nativeEffort: pickModel(registry.find("9router", "cx/native-effort")),
      manualModel: pickModel(registry.find("9router", "cx/manual-model")),
      otherModel: pickModel(registry.find("other", "keep-me")),
    },
    hasProvider9router: registry.hasProvider("9router"),
    discoveryState: registry.getProviderDiscoveryState("9router") ?? null,
    runtimeDiscoveryFailures: registry.getRuntimeDiscoveryFailures(),
    fingerprint,
    verdict,
    verdictKey,
    cacheRows,
    diagnostic,
  };

  AgentStorage.close();
  return result;
}

function extensionSnapshot(extension: Extension): {
  path: string;
  resolvedPath: string;
  registersProviders: boolean;
} {
  return {
    path: extension.path,
    resolvedPath: extension.resolvedPath,
    registersProviders: extension.registersProviders === true,
  };
}

function pickModels(models: readonly HostPublicModel[]): SerializedModel[] {
  const picked: SerializedModel[] = [];
  for (const model of models) {
    const serialized = pickModel(model);
    if (serialized) picked.push(serialized);
  }
  return picked;
}

function pickModel(model: HostPublicModel | undefined): SerializedModel | null {
  if (!model) return null;
  const thinking = model.thinking
    ? {
        mode: model.thinking.mode,
        efforts: [...model.thinking.efforts],
        defaultLevel: model.thinking.defaultLevel,
        requiresEffort: model.thinking.requiresEffort,
        unverified: model.thinking.unverified,
      }
    : null;
  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl ?? null,
    reasoning: model.reasoning,
    thinking,
    input: [...model.input],
    supportsTools: model.supportsTools,
    cost: {
      input: model.cost.input ?? null,
      output: model.cost.output ?? null,
      cacheRead: model.cost.cacheRead ?? null,
      cacheWrite: model.cost.cacheWrite ?? null,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    requestModelId: model.requestModelId,
  };
}

async function fingerprintSource(extensionPath: string): Promise<string> {
  const stats = await stat(extensionPath);
  return `${stats.size}:${stats.mtimeMs}`;
}

async function readDiagnostic(
  path: string,
): Promise<SerializedDiagnostic | null> {
  try {
    return (await Bun.file(path).json()) as SerializedDiagnostic;
  } catch {
    return null;
  }
}

async function readCacheRows(cacheDbPath: string): Promise<unknown> {
  if (!(await Bun.file(cacheDbPath).exists())) return [];
  const db = new Database(cacheDbPath, { readonly: true });
  try {
    return db
      .query(
        "SELECT provider_id, updated_at, authoritative FROM model_cache WHERE provider_id = '9router'",
      )
      .all();
  } finally {
    db.close();
  }
}

async function readHostPackageVersion(repoRoot: string): Promise<string> {
  const packagePath = join(
    repoRoot,
    "node_modules",
    "@oh-my-pi",
    "pi-coding-agent",
    "package.json",
  );
  const packageJson = (await Bun.file(packagePath).json()) as {
    version?: unknown;
  };
  return typeof packageJson.version === "string"
    ? packageJson.version
    : "unknown";
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

if (process.env[CHILD_ENV] !== "1") {
  const { afterAll, expect, test } = await import("bun:test");
  const temporaryRoots: string[] = [];
  let scenarioCounter = 0;

  afterAll(async () => {
    for (const root of temporaryRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  interface TestContext {
    root: string;
    agentDir: string;
    workDir: string;
    homeDir: string;
    modelsPath: string;
    extensionPath: string;
    rosterPath: string;
    staleRosterPath: string;
    diagnosticPath: string;
  }

  test("startup contract: eager provider roster, authority, and native effort", async () => {
    const context = await createContext("contract");
    const snapshot = await runScenario(context, "success", "offline");

    assertCompliantRuntime(snapshot);
    expect(snapshot.extension).not.toBeNull();
    expect(snapshot.extension?.path).toBe(context.extensionPath);
    expect(snapshot.extension?.resolvedPath).toBe(
      resolve(context.extensionPath),
    );
    expect(snapshot.extension?.registersProviders).toBe(true);
    expect(snapshot.deferredPaths).toEqual([]);
    expect(snapshot.loadErrors).toEqual([]);

    expect(snapshot.models9router.map((model) => model.id).sort()).toEqual([
      "cx/native-effort",
      "cx/test-model",
      "cx/unguarded-model",
    ]);

    const testModel = requireModel(snapshot.selection.testModel);
    expect(testModel.id).toBe("cx/test-model");
    expect(testModel.api).toBe("openai-completions");
    expect(testModel.baseUrl).toBe("http://127.0.0.1:20128/v1");
    expect(testModel.reasoning).toBe(true);
    expect(testModel.thinking).toBeNull();
    expect(testModel.supportsTools).toBe(false);
    expect(testModel.input).toEqual(["text"]);
    expect(testModel.cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
    });
    expect(testModel.contextWindow).toBe(65_536);
    expect(testModel.maxTokens).toBe(8_192);

    const nativeEffort = requireModel(snapshot.selection.nativeEffort);
    expect(nativeEffort.thinking?.efforts).toEqual(["low", "high"]);
    expect(nativeEffort.supportsTools).toBe(true);
    expect(nativeEffort.input).toEqual(["text", "image"]);

    // Control: the same unknown id without the explicit-thinking guard gets a
    // host-inferred ladder, proving the guarded model's empty ladder is not a
    // side effect of an unknown identity.
    const unguarded = snapshot.models9router.find(
      (model) => model.id === "cx/unguarded-model",
    );
    expect(unguarded?.thinking?.efforts?.length ?? 0).toBeGreaterThan(0);

    expect(snapshot.hasProvider9router).toBe(true);
    expect(snapshot.selection.otherModel?.id).toBe("keep-me");
    expect(snapshot.verdict?.deferrable).toBe(false);
    expect(snapshot.verdict?.fingerprint).toBe(snapshot.fingerprint);
    expect(PUBLIC_PROVIDER_CONFIG.models).toBe(ROSTER);
    expect(snapshot.network).toEqual({ policy: "disabled-fetch", calls: 0 });

    const { ok: _ok, ...evidence } = snapshot;
    await writeEvidence("task-11-contract.json", evidence);
    logSnapshot("HOST_CONTRACT_SNAPSHOT", evidence);
  }, 150_000);

  test("startup contract: conflicting provider config is diagnostic without user-model removal", async () => {
    const context = await createContext("conflict", { conflict: true });
    const snapshot = await runScenario(context, "conflict", "offline");

    assertCompliantRuntime(snapshot);
    expect(snapshot.extension?.registersProviders).toBe(true);
    expect(snapshot.diagnostic?.code).toBe("config-conflict");
    expect(snapshot.diagnostic?.provider).toBe("9router");
    expect(snapshot.diagnostic?.unsupported).toEqual(
      expect.arrayContaining(["models", "discovery", "modelOverrides"]),
    );
    expect(snapshot.diagnostic?.removedUserModels).toBeUndefined();

    const manualModel = requireModel(snapshot.selection.manualModel);
    expect(manualModel.id).toBe("cx/manual-model");
    expect(manualModel.contextWindow).toBe(12_345);
    expect(snapshot.models9router.map((model) => model.id)).toContain(
      "cx/manual-model",
    );
    expect(snapshot.selection.otherModel?.id).toBe("keep-me");
    expect(snapshot.network).toEqual({ policy: "disabled-fetch", calls: 0 });

    const { ok: _ok, ...evidence } = snapshot;
    await writeEvidence("task-11-conflict.json", evidence);
    logSnapshot("HOST_CONTRACT_CONFLICT_SNAPSHOT", evidence);
  }, 150_000);

  test("failure recovery: stale native cache stays inert without a discovery manager", async () => {
    const context = await createContext("recovery-stale");
    const seeded = await runScenario(context, "seed", "online");

    assertCompliantRuntime(seeded);
    expect(seeded.models9router.map((model) => model.id)).toEqual([
      "stale/legacy-model",
    ]);
    expect(seeded.verdict?.deferrable).toBe(false);
    expect(seeded.cacheRows).not.toEqual([]);

    await ageDiscoveryCache(context.agentDir);

    // A manager that opts into cache-backed discovery can still read the aged
    // row. This proves the cache is valid and that the failure path's empty
    // marker, not cache corruption, is what keeps the roster inert.
    const offlineSeed = await runScenario(context, "seed", "offline");
    expect(offlineSeed.models9router.map((model) => model.id)).toEqual([
      "stale/legacy-model",
    ]);
    expect(offlineSeed.verdict?.fingerprint).toBe(seeded.verdict?.fingerprint);

    const failure = await runScenario(context, "failure", "offline");
    expect(failure.deferredPaths).toEqual([]);
    expect(failure.extension?.registersProviders).toBe(true);
    expect(failure.models9router).toEqual([]);
    expect(failure.selection.testModel).toBeNull();
    expect(failure.selection.manualModel).toBeNull();
    expect(failure.selection.otherModel?.id).toBe("keep-me");
    expect(failure.diagnostic?.code).toBe("discovery-failed");
    expect(failure.verdict?.deferrable).toBe(false);
    expect(failure.verdict?.fingerprint).toBe(seeded.verdict?.fingerprint);
    expect(failure.network).toEqual({ policy: "disabled-fetch", calls: 0 });

    // Rewrite the stored verdict as deferrable with the exact same path and
    // fingerprint. The next process must then defer the module, proving the
    // verdict is read cross-process rather than inferred from a cold start.
    writeStoredVerdict(
      context.agentDir,
      context.extensionPath,
      seeded.fingerprint,
      true,
    );
    const deferred = await runScenario(context, "failure", "offline");
    expect(deferred.deferredPaths).toContain(resolve(context.extensionPath));
    expect(deferred.extensions).toEqual([]);
    expect(deferred.models9router).toEqual([]);

    const { ok: _ok, ...evidence } = {
      ...failure,
      seed: seeded,
      offlineSeed,
      deferred,
    };
    await writeEvidence("task-11-recovery.json", evidence);
    logSnapshot("HOST_RECOVERY_SNAPSHOT", evidence);
  }, 510_000);

  test("failure recovery: success after failure stays eager and the next process is empty", async () => {
    const context = await createContext("recovery-success");
    const seeded = await runScenario(context, "seed", "online");
    await ageDiscoveryCache(context.agentDir);

    const failure = await runScenario(context, "failure", "offline");
    expect(failure.models9router).toEqual([]);
    expect(failure.deferredPaths).toEqual([]);

    const success = await runScenario(context, "success", "offline");
    assertCompliantRuntime(success);
    expect(success.deferredPaths).toEqual([]);
    expect(success.extensions).toHaveLength(1);
    expect(success.extension?.registersProviders).toBe(true);
    expect(success.models9router.map((model) => model.id).sort()).toEqual([
      "cx/native-effort",
      "cx/test-model",
      "cx/unguarded-model",
    ]);
    expect(success.selection.testModel?.supportsTools).toBe(false);
    expect(success.verdict?.deferrable).toBe(false);
    expect(success.verdict?.fingerprint).toBe(failure.verdict?.fingerprint);
    expect(success.verdict?.fingerprint).toBe(seeded.verdict?.fingerprint);

    const afterSuccess = await runScenario(context, "failure", "offline");
    expect(afterSuccess.deferredPaths).toEqual([]);
    expect(afterSuccess.models9router).toEqual([]);
    expect(afterSuccess.selection.otherModel?.id).toBe("keep-me");
    expect(afterSuccess.verdict?.fingerprint).toBe(
      success.verdict?.fingerprint,
    );

    const { ok: _ok, ...evidence } = {
      ...success,
      seed: seeded,
      failure,
      afterSuccess,
    };
    await writeEvidence("task-11-recovery-success.json", evidence);
    logSnapshot("HOST_RECOVERY_SUCCESS_SNAPSHOT", evidence);
  }, 510_000);

  async function createContext(
    label: string,
    options: { conflict?: boolean } = {},
  ): Promise<TestContext> {
    const root = await mkdtemp(join(tmpdir(), `omp-host-contract-${label}-`));
    temporaryRoots.push(root);
    const agentDir = join(root, "agent");
    const workDir = join(root, "work");
    const homeDir = join(root, "home");
    const tempDir = join(root, "tmp");
    for (const directory of [agentDir, workDir, homeDir, tempDir]) {
      await mkdir(directory, { recursive: true });
    }

    const modelsPath = join(agentDir, "models.yml");
    await writeFile(modelsPath, modelsYaml(options.conflict === true));
    const rosterPath = join(root, "roster.json");
    await writeFile(rosterPath, `${JSON.stringify(ROSTER)}\n`);
    const staleRosterPath = join(root, "stale-roster.json");
    await writeFile(staleRosterPath, `${JSON.stringify(STALE_ROSTER)}\n`);
    const extensionPath = join(
      root,
      "extensions",
      "host-contract-extension.ts",
    );
    await mkdir(dirname(extensionPath), { recursive: true });
    await writeFile(extensionPath, extensionSource());
    const diagnosticPath = join(root, "diagnostic.json");

    return {
      root,
      agentDir,
      workDir,
      homeDir,
      modelsPath,
      extensionPath,
      rosterPath,
      staleRosterPath,
      diagnosticPath,
    };
  }

  async function runScenario(
    context: TestContext,
    mode: ScenarioMode,
    refreshStrategy: RefreshStrategy,
  ): Promise<ChildResult> {
    scenarioCounter++;
    const requestPath = join(context.root, `request-${scenarioCounter}.json`);
    const resultPath = join(context.root, `result-${scenarioCounter}.json`);
    const request: ScenarioRequest = {
      repoRoot: resolve(import.meta.dir, ".."),
      agentDir: context.agentDir,
      workDir: context.workDir,
      modelsPath: context.modelsPath,
      extensionPath: context.extensionPath,
      rosterPath: context.rosterPath,
      staleRosterPath: context.staleRosterPath,
      diagnosticPath: context.diagnosticPath,
      resultPath,
      mode,
      refreshStrategy,
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);

    const proc = Bun.spawn({
      cmd: [process.execPath, import.meta.path],
      cwd: context.workDir,
      env: childEnvironment(context, requestPath, mode),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(
            new Error(
              `host-contract child exceeded its time budget (pid ${proc.pid})`,
            ),
          );
        }, CHILD_TIMEOUT_MS);
      }),
    ]);
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await bounded;
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }

    let result: ChildResult | ChildFailure;
    try {
      result = (await Bun.file(resultPath).json()) as
        | ChildResult
        | ChildFailure;
    } catch {
      throw new Error(
        `host-contract child wrote no result (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    if (exitCode !== 0 || !result.ok) {
      const failure = result as ChildFailure;
      throw new Error(
        `host-contract child failed (exit ${exitCode}): ${failure.error}\n${failure.stack ?? ""}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    return result;
  }

  function childEnvironment(
    context: TestContext,
    requestPath: string,
    mode: ScenarioMode,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    // Never inherit a user's profile selection or ambient agent directory.
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
    delete env.OPENCODE_CONFIG_DIR;
    env.HOME = context.homeDir;
    env.PI_CODING_AGENT_DIR = context.agentDir;
    env.XDG_CACHE_HOME = join(context.homeDir, ".cache");
    env.XDG_CONFIG_HOME = join(context.homeDir, ".config");
    env.XDG_DATA_HOME = join(context.homeDir, ".local", "share");
    env.XDG_STATE_HOME = join(context.homeDir, ".local", "state");
    env.TMPDIR = join(context.root, "tmp");
    env.DO_NOT_TRACK = "1";
    env.OMP_DISABLE_TELEMETRY = "1";
    env[CHILD_ENV] = "1";
    env[REQUEST_ENV] = requestPath;
    env.HOST_CONTRACT_MODE = mode;
    env.HOST_CONTRACT_AGENT_DIR = context.agentDir;
    env.HOST_CONTRACT_MODELS_PATH = context.modelsPath;
    env.HOST_CONTRACT_ROSTER_PATH = context.rosterPath;
    env.HOST_CONTRACT_STALE_ROSTER_PATH = context.staleRosterPath;
    env.HOST_CONTRACT_DIAG_PATH = context.diagnosticPath;
    return env;
  }

  function modelsYaml(conflict: boolean): string {
    const conflictBlock = conflict
      ? `    discovery:\n      type: openai-models-list\n    models:\n      - id: cx/manual-model\n        name: cx/manual-model\n        reasoning: true\n        input: [text]\n        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 65536\n        maxTokens: 8192\n    modelOverrides:\n      cx/manual-model:\n        contextWindow: 12345\n`
      : "";
    return `providers:\n  "9router":\n    baseUrl: http://127.0.0.1:20128/v1\n    api: openai-completions\n    apiKey: ${HOST_CONTRACT_TEST_TOKEN}\n${conflictBlock}  "other":\n    baseUrl: http://127.0.0.1:9999/v1\n    api: openai-completions\n    apiKey: ${OTHER_PROVIDER_TOKEN}\n    models:\n      - id: keep-me\n        name: keep-me\n        reasoning: false\n        input: [text]\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 32768\n        maxTokens: 4096\n`;
  }

  function extensionSource(): string {
    return `export default async function hostContractExtension(pi) {
	const mode = process.env.HOST_CONTRACT_MODE || "success";
	const modelsPath = process.env.HOST_CONTRACT_MODELS_PATH;
	const rosterPath = process.env.HOST_CONTRACT_ROSTER_PATH;
	const staleRosterPath = process.env.HOST_CONTRACT_STALE_ROSTER_PATH;
	const diagnosticPath = process.env.HOST_CONTRACT_DIAG_PATH;
	const writeDiagnostic = async value => {
		if (diagnosticPath) await Bun.write(diagnosticPath, JSON.stringify(value));
	};

	if (mode === "failure") {
		// The product-owning marker is registered even when discovery fails.
		pi.registerProvider("9router", {});
		await writeDiagnostic({
			code: "discovery-failed",
			provider: "9router",
			message: "fixture discovery unavailable",
		});
		return;
	}

	if (mode === "conflict") {
		pi.registerProvider("9router", {});
		const config = Bun.YAML.parse(await Bun.file(modelsPath).text());
		const provider = config?.providers?.["9router"] ?? {};
		const unsupported = ["models", "discovery", "modelOverrides"].filter(
			key => provider[key] !== undefined,
		);
		await writeDiagnostic({ code: "config-conflict", provider: "9router", unsupported });
		return;
	}

	const config = Bun.YAML.parse(await Bun.file(modelsPath).text());
	const provider = config.providers["9router"];
	const connection = {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
		api: provider.api ?? "openai-completions",
	};

	if (mode === "seed") {
		const staleRoster = await Bun.file(staleRosterPath).json();
		pi.registerProvider("9router", {
			...connection,
			fetchDynamicModels: async () => staleRoster,
		});
		return;
	}

	const roster = await Bun.file(rosterPath).json();
	pi.registerProvider("9router", { ...connection, models: roster });
}
`;
  }

  async function ageDiscoveryCache(agentDir: string): Promise<void> {
    const db = new Database(join(agentDir, "models.db"));
    try {
      const row = db
        .query(
          "SELECT provider_id, updated_at FROM model_cache WHERE provider_id = '9router'",
        )
        .get() as { provider_id?: string; updated_at?: number } | null;
      expect(row?.provider_id).toBe("9router");
      db.run(
        "UPDATE model_cache SET updated_at = 1 WHERE provider_id = '9router'",
      );
      const refreshTable = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_cache_refresh'",
        )
        .get() as { name?: string } | null;
      if (refreshTable?.name === "model_cache_refresh") {
        db.run(
          "UPDATE model_cache_refresh SET updated_at = 1, payload_updated_at = 1 WHERE provider_id = '9router'",
        );
      }
      const aged = db
        .query(
          "SELECT updated_at FROM model_cache WHERE provider_id = '9router'",
        )
        .get() as { updated_at?: number } | null;
      expect(aged?.updated_at).toBe(1);
    } finally {
      db.close();
    }
  }

  function writeStoredVerdict(
    agentDir: string,
    extensionPath: string,
    fingerprint: string,
    deferrable: boolean,
  ): void {
    const db = new Database(join(agentDir, "agent.db"));
    try {
      const key = `extension_startup:v2:${resolve(extensionPath)}`;
      const value = JSON.stringify({ fingerprint, deferrable });
      const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
      db.run(
        "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        [key, value, expiresAt],
      );
    } finally {
      db.close();
    }
  }

  function assertCompliantRuntime(snapshot: ScenarioResult): void {
    expect(snapshot.versions.host).toBe("18.20.0");
    expect(snapshot.versions.package).toBe("18.20.0");
    expect(
      compareVersions(snapshot.versions.bun, "1.4.4"),
    ).toBeGreaterThanOrEqual(0);
  }

  function requireModel(model: SerializedModel | null): SerializedModel {
    if (!model) throw new Error("expected model in final registry snapshot");
    return model;
  }

  function compareVersions(left: string, right: string): number {
    const leftParts = left
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    const rightParts = right
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    for (
      let index = 0;
      index < Math.max(leftParts.length, rightParts.length);
      index++
    ) {
      const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }

  async function writeEvidence(name: string, value: unknown): Promise<void> {
    const configured =
      process.env.EVIDENCE_DIR ?? join(".omo", "evidence", "omp-9router-plus");
    const directory = isAbsolute(configured)
      ? configured
      : resolve(import.meta.dir, "..", configured);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  function logSnapshot(label: string, value: unknown): void {
    // The QA commands redirect stdout to the evidence log, so this is the
    // human-readable registry/selection/version snapshot for the verifier.
    console.log(`${label} ${JSON.stringify(value)}`);
  }
}
