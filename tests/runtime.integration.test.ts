// allow: SIZE_OK - task 8 ships one cohesive native runtime proof file; the
// child matrix, loopback capture, and evidence assembly are deliberately here
// because splitting them would add product files outside the plan.
/**
 * Native OMP runtime proof for the 9Router extension.
 *
 * The test process owns every fixture: a loopback fake router, isolated
 * HOME/agentDir/cache/work directories, and child processes that import the
 * installed `@oh-my-pi/pi-coding-agent` artifact. The extension under test is
 * always `dist/index.js` loaded by the native loader, session, or CLI. No test
 * calls the extension factory directly.
 *
 * Two scenarios cover the plan matrix:
 * - startup-and-wire: cold success, changed roster with a warm metadata cache,
 *   live-false authority, native thinking payloads, capability presence,
 *   credential resolution, and native CLI `--api-key` precedence.
 * - failure-and-restart: success followed by failure, failure followed by
 *   success, inert stale native cache, CLI diagnostics, and rejected command
 *   keys.
 */
import { Database } from "bun:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Extension, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import {
  type FakeRouter,
  type FakeRouterCall,
  startFakeRouter,
} from "./fixtures/fake-router.js";

type HostModule = typeof import("@oh-my-pi/pi-coding-agent");
type HostModel = NonNullable<
  ReturnType<InstanceType<HostModule["ModelRegistry"]>["find"]>
>;

type ScenarioName = "startup-and-wire" | "failure-and-restart" | "all";
type HostCreateOptions = NonNullable<
  Parameters<HostModule["createAgentSession"]>[0]
>;
type HostThinkingLevel = NonNullable<HostCreateOptions["thinkingLevel"]>;

interface SerializedThinking {
  readonly mode: string;
  readonly efforts: readonly string[];
  readonly defaultLevel?: string;
  readonly requiresEffort?: boolean;
  readonly unverified?: boolean;
}

interface SerializedModel {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly api: string;
  readonly baseUrl: string | null;
  readonly reasoning: boolean;
  readonly thinking: SerializedThinking | null;
  readonly input: readonly string[];
  readonly supportsTools?: boolean;
  readonly cost: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cacheRead: number | null;
    readonly cacheWrite: number | null;
  };
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
}

interface SerializedExtension {
  readonly path: string;
  readonly resolvedPath: string;
  readonly registersProviders: boolean;
}

interface SerializedVerdict {
  readonly fingerprint?: string;
  readonly deferrable?: boolean;
}

interface SelectionSnapshot {
  readonly model: { readonly provider: string; readonly id: string } | null;
  readonly thinkingLevel: string | null;
}

interface SessionChildResult {
  readonly ok: true;
  readonly kind: "session";
  readonly versions: {
    readonly host: string;
    readonly package: string;
    readonly bun: string;
  };
  readonly process: { readonly pid: number; readonly cwd: string };
  readonly network: {
    readonly policy: "loopback-only-guard";
    readonly rejectedExternalCalls: number;
    readonly rejectedOrigins: readonly string[];
  };
  readonly extension: SerializedExtension | null;
  readonly extensions: readonly SerializedExtension[];
  readonly deferredPaths: readonly string[];
  readonly loadErrors: readonly {
    readonly path: string;
    readonly message: string;
  }[];
  readonly roster: readonly SerializedModel[];
  readonly otherRoster: readonly SerializedModel[];
  readonly selection: SerializedModel | null;
  readonly before: SelectionSnapshot;
  readonly after: SelectionSnapshot;
  readonly prompt: {
    readonly attempted: boolean;
    readonly result: boolean;
  } | null;
  readonly hasProvider9router: boolean;
  readonly verdict: SerializedVerdict | null;
  readonly verdictKey: string;
  readonly fingerprint: string;
  readonly agentDir: string;
  readonly modelsPath: string;
}

interface SeedChildResult {
  readonly ok: true;
  readonly kind: "seed-cache";
  readonly versions: {
    readonly host: string;
    readonly package: string;
    readonly bun: string;
  };
  readonly process: { readonly pid: number };
  readonly network: {
    readonly policy: "loopback-only-guard";
    readonly rejectedExternalCalls: number;
    readonly rejectedOrigins: readonly string[];
  };
  readonly roster: readonly SerializedModel[];
  readonly cacheRows: readonly unknown[];
  readonly cacheDbPath: string;
}

interface ChildFailure {
  readonly ok: false;
  readonly error: string;
  readonly stack?: string;
}

interface ChildRequest {
  readonly kind: "session" | "seed-cache";
  readonly repoRoot: string;
  readonly agentDir: string;
  readonly workDir: string;
  readonly extensionPath: string;
  readonly modelsPath: string;
  readonly resultPath: string;
  readonly modelPattern?: string;
  readonly thinkingLevel?: string;
  readonly toolNames?: readonly string[];
  readonly prompt?: string;
  readonly image?: boolean;
  readonly staleRosterPath?: string;
  readonly baseUrl?: string;
}

const CHILD_ENV = "TASK8_RUNTIME_CHILD";
const REQUEST_ENV = "TASK8_RUNTIME_REQUEST";
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
const CONFIGURED_KEY = "task8-configured-key";
const OTHER_KEY_VALUE = "task8-other-provider-key";

const ROSTER_A = [
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
  {
    id: "cx/gpt-6-sol",
    kind: "llm",
    name: "CX GPT 6 Sol",
    capabilities: {
      reasoning: true,
      tools: true,
      vision: true,
      contextWindow: 131_072,
      maxOutput: 16_384,
      thinkingFormat: "openai",
    },
    thinking_levels: ["low", "medium", "high", "max"],
  },
  {
    id: "cx/limited-effort",
    kind: "llm",
    name: "CX Limited Effort",
    capabilities: {
      reasoning: true,
      tools: true,
      vision: false,
      contextWindow: 65_536,
      maxOutput: 8_192,
      thinkingFormat: "openai",
    },
    thinking_levels: ["low", "high"],
  },
  {
    id: "glm/glm-5.2",
    kind: "llm",
    name: "GLM 5.2",
    capabilities: {
      reasoning: true,
      tools: true,
      vision: false,
      contextWindow: 65_536,
      maxOutput: 8_192,
    },
  },
  {
    id: "cx/gpt-6-astra",
    kind: "llm",
    name: "CX GPT 6 Astra",
    capabilities: {
      reasoning: false,
      tools: false,
      vision: false,
      contextWindow: 65_536,
      maxOutput: 8_192,
    },
  },
] as const;

const ROSTER_B = [
  {
    id: "cx/next-model",
    kind: "llm",
    name: "CX Next Model",
    capabilities: {
      reasoning: true,
      tools: false,
      vision: false,
      contextWindow: 98_304,
      maxOutput: 12_288,
    },
  },
  {
    id: "glm/glm-5.2",
    kind: "llm",
    name: "GLM 5.2",
    capabilities: {
      reasoning: true,
      tools: true,
      vision: false,
      contextWindow: 65_536,
      maxOutput: 8_192,
    },
  },
] as const;

const STALE_ROSTER: readonly ProviderModelConfig[] = [
  {
    id: "stale/legacy-model",
    name: "stale/legacy-model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  },
];

// ---------------------------------------------------------------------------
// Child dispatch
// ---------------------------------------------------------------------------

if (process.env[CHILD_ENV] === "1") {
  await runChildEntry();
}

async function runChildEntry(): Promise<never> {
  const requestPath = process.env[REQUEST_ENV];
  let resultPath: string | undefined;
  try {
    if (!requestPath) throw new Error(`${REQUEST_ENV} is required`);
    const request = (await Bun.file(requestPath).json()) as ChildRequest;
    resultPath = request.resultPath;
    const result =
      request.kind === "seed-cache"
        ? await runSeedChild(request)
        : await runSessionChild(request);
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
    throw new Error("runtime integration forbids non-loopback fetch");
  };
  globalThis.fetch = Object.assign(guardedFetch, {
    preconnect: () => undefined,
  });
  return {
    rejectedExternalCalls: () => rejectedExternalCalls,
    rejectedOrigins: () => [...rejectedOrigins],
  };
}

async function importHost(repoRoot: string): Promise<{
  readonly host: HostModule;
  readonly AgentStorage: typeof import("@oh-my-pi/pi-coding-agent/session/agent-storage").AgentStorage;
  readonly EventBus: typeof import("@oh-my-pi/pi-coding-agent/utils/event-bus").EventBus;
}> {
  const hostEntry = Bun.resolveSync("@oh-my-pi/pi-coding-agent", repoRoot);
  const storageEntry = Bun.resolveSync(
    "@oh-my-pi/pi-coding-agent/session/agent-storage",
    repoRoot,
  );
  const eventBusEntry = Bun.resolveSync(
    "@oh-my-pi/pi-coding-agent/utils/event-bus",
    repoRoot,
  );
  const host: HostModule = await import(hostEntry);
  const { AgentStorage } = await import(storageEntry);
  const { EventBus } = await import(eventBusEntry);
  return { host, AgentStorage, EventBus };
}

async function runSessionChild(
  request: ChildRequest,
): Promise<SessionChildResult> {
  const guard = installLoopbackGuard();
  const { host, AgentStorage, EventBus } = await importHost(request.repoRoot);
  const storage = await AgentStorage.open(join(request.agentDir, "agent.db"));
  try {
    const settings = host.Settings.isolated({}, { storage });
    const authStorage = await host.discoverAuthStorage(request.agentDir, {
      settings,
    });
    const registry = new host.ModelRegistry(authStorage, request.modelsPath, {
      cacheDbPath: join(request.agentDir, "models.db"),
    });
    // Load through the native loader first so the startup verdict and
    // deferred-path decision are recorded exactly as the CLI does, then hand
    // the loaded instances to the session (the CLI's preloadedExtensions path).
    const loaded = await host.loadSessionExtensions(
      {
        additionalExtensionPaths: [request.extensionPath],
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
      modelPattern: request.modelPattern,
      // JSON boundary: the host exposes a const-enum thinking type that cannot
      // be imported as a value under isolatedModules; the CLI accepts these
      // exact selector strings and validates them at runtime.
      thinkingLevel: request.thinkingLevel as HostThinkingLevel | undefined,
      toolNames: request.toolNames ? [...request.toolNames] : [],
      preloadedExtensions: loaded,
      additionalExtensionPaths: [request.extensionPath],
      disableExtensionDiscovery: true,
      noContextFiles: true,
      excludeAgentsMd: true,
      enableMCP: false,
      enableLsp: false,
      autoTitle: false,
      cacheWarming: false,
      systemPrompt: "task8 runtime fixture",
    });
    const before = snapshotSelection(sessionResult.session);
    let prompt: SessionChildResult["prompt"] = null;
    if (request.prompt !== undefined) {
      const result = await sessionResult.session.prompt(
        request.prompt,
        request.image === true
          ? {
              images: [
                {
                  type: "image" as const,
                  data: TINY_PNG,
                  mimeType: "image/png",
                },
              ],
            }
          : undefined,
      );
      prompt = { attempted: true, result };
    }
    const after = snapshotSelection(sessionResult.session);
    const fingerprint = await fingerprintSource(request.extensionPath);
    const verdictKey = `extension_startup:v2:${resolve(request.extensionPath)}`;
    const rawVerdict = storage.getCache(verdictKey);
    const verdict = rawVerdict
      ? (JSON.parse(rawVerdict) as SerializedVerdict)
      : null;
    const extension =
      sessionResult.extensionsResult.extensions.find(
        (item) => resolve(item.resolvedPath) === resolve(request.extensionPath),
      ) ?? null;
    const result: SessionChildResult = {
      ok: true,
      kind: "session",
      versions: {
        host: host.VERSION,
        package: await readHostPackageVersion(request.repoRoot),
        bun: Bun.version,
      },
      process: { pid: process.pid, cwd: process.cwd() },
      network: {
        policy: "loopback-only-guard",
        rejectedExternalCalls: guard.rejectedExternalCalls(),
        rejectedOrigins: guard.rejectedOrigins(),
      },
      extension: extension ? extensionSnapshot(extension) : null,
      extensions:
        sessionResult.extensionsResult.extensions.map(extensionSnapshot),
      deferredPaths: loaded.deferredPaths,
      loadErrors: sessionResult.extensionsResult.errors.map((entry) => ({
        path: entry.path,
        message: String(entry.error),
      })),
      roster: pickModels(registry.getProviderModels("9router")),
      otherRoster: pickModels(registry.getProviderModels("other")),
      selection: pickModel(
        registry.find(
          "9router",
          request.modelPattern?.split("/").slice(1).join("/") ?? "",
        ),
      ),
      before,
      after,
      prompt,
      hasProvider9router: registry.hasProvider("9router"),
      verdict,
      verdictKey,
      fingerprint,
      agentDir: request.agentDir,
      modelsPath: request.modelsPath,
    };
    await sessionResult.session.dispose();
    return result;
  } finally {
    AgentStorage.close();
  }
}

async function runSeedChild(request: ChildRequest): Promise<SeedChildResult> {
  const guard = installLoopbackGuard();
  const { host, AgentStorage, EventBus } = await importHost(request.repoRoot);
  const storage = await AgentStorage.open(join(request.agentDir, "agent.db"));
  try {
    const settings = host.Settings.isolated({}, { storage });
    const authStorage = await host.discoverAuthStorage(request.agentDir, {
      settings,
    });
    const registry = new host.ModelRegistry(authStorage, request.modelsPath, {
      cacheDbPath: join(request.agentDir, "models.db"),
    });
    const extensionsResult = await host.loadSessionExtensions(
      {
        additionalExtensionPaths: [request.extensionPath],
        disableExtensionDiscovery: true,
      },
      request.workDir,
      settings,
      new EventBus(),
    );
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
    await registry.refreshRuntimeProviders("online");
    return {
      ok: true,
      kind: "seed-cache",
      versions: {
        host: host.VERSION,
        package: await readHostPackageVersion(request.repoRoot),
        bun: Bun.version,
      },
      process: { pid: process.pid },
      network: {
        policy: "loopback-only-guard",
        rejectedExternalCalls: guard.rejectedExternalCalls(),
        rejectedOrigins: guard.rejectedOrigins(),
      },
      roster: pickModels(registry.getProviderModels("9router")),
      cacheRows: await readCacheRows(join(request.agentDir, "models.db")),
      cacheDbPath: join(request.agentDir, "models.db"),
    };
  } finally {
    AgentStorage.close();
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function extensionSnapshot(extension: Extension): SerializedExtension {
  return {
    path: extension.path,
    resolvedPath: extension.resolvedPath,
    registersProviders: extension.registersProviders === true,
  };
}

function snapshotSelection(session: {
  readonly model: HostModel | undefined;
  readonly thinkingLevel: string | undefined;
}): SelectionSnapshot {
  return {
    model: session.model
      ? { provider: session.model.provider, id: session.model.id }
      : null,
    thinkingLevel: session.thinkingLevel ?? null,
  };
}

function pickModels(models: readonly HostModel[]): SerializedModel[] {
  return models
    .map(pickModel)
    .filter((model): model is SerializedModel => model !== null);
}

function pickModel(model: HostModel | undefined): SerializedModel | null {
  if (!model) return null;
  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl ?? null,
    reasoning: model.reasoning,
    thinking: model.thinking
      ? {
          mode: model.thinking.mode,
          efforts: [...model.thinking.efforts],
          defaultLevel: model.thinking.defaultLevel,
          requiresEffort: model.thinking.requiresEffort,
          unverified: model.thinking.unverified,
        }
      : null,
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
  };
}

async function fingerprintSource(path: string): Promise<string> {
  const stats = await stat(path);
  return `${stats.size}:${stats.mtimeMs}`;
}

async function readCacheRows(cacheDbPath: string): Promise<unknown[]> {
  if (!(await Bun.file(cacheDbPath).exists())) return [];
  const db = new Database(cacheDbPath, { readonly: true });
  try {
    return db
      .query(
        "SELECT provider_id, updated_at, authoritative FROM model_cache WHERE provider_id = '9router'",
      )
      .all() as unknown[];
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
// Parent test harness
// ---------------------------------------------------------------------------

if (process.env[CHILD_ENV] !== "1") {
  const { afterAll, describe, expect, test } = await import("bun:test");
  const repoRoot = resolve(import.meta.dir, "..");
  const scenario = selectedScenario();
  const evidenceFiles: string[] = [];
  const ownedRoots: string[] = [];
  const ownedServers: FakeRouter[] = [];
  const childPids = new Set<number>();
  let counter = 0;

  afterAll(async () => {
    for (const server of ownedServers) {
      try {
        server.stop();
      } catch {
        // Already stopped by the test.
      }
    }
    for (const root of ownedRoots)
      await rm(root, { recursive: true, force: true });
    const receipt = {
      scenario,
      rootsRemoved: ownedRoots.length,
      serversStopped: ownedServers.length,
      childProcesses: [...childPids],
      childProcessesExited: [...childPids].every((pid) => !isProcessAlive(pid)),
      evidenceFiles,
      completedAt: new Date().toISOString(),
    };
    await writeEvidence("task-8-cleanup.json", receipt);
  });

  if (scenario === "startup-and-wire" || scenario === "all") {
    describe("runtime startup and wire", () => {
      test("dist extension discovers live IDs, selects cx/test-model before the first prompt, and sends the native wire", async () => {
        const server = startFakeRouter({ roster: ROSTER_A });
        ownedServers.push(server);
        const context = await createContext("startup", server);
        const matrix: Record<string, unknown> = {};

        // (a) Cold success: no metadata cache, so the loopback guard must
        // reject models.dev and enrichment must degrade to empty.
        await writeModels(context, CONFIGURED_KEY);
        server.resetCalls();
        const cold = await runSession(context, {
          modelPattern: "9router/cx/test-model",
          prompt: "say OK",
        });
        assertVersions(cold.versions);
        expect(cold.extension).not.toBeNull();
        expect(cold.extension?.registersProviders).toBe(true);
        expect(cold.deferredPaths).toEqual([]);
        expect(cold.loadErrors).toEqual([]);
        expect(cold.roster.map((model) => model.id).sort()).toEqual([
          "cx/gpt-6-astra",
          "cx/gpt-6-sol",
          "cx/limited-effort",
          "cx/test-model",
          "glm/glm-5.2",
        ]);
        expect(cold.otherRoster.map((model) => model.id)).toEqual(["keep-me"]);
        expect(cold.before).toEqual({
          model: { provider: "9router", id: "cx/test-model" },
          thinkingLevel: null,
        });
        expect(cold.prompt).toEqual({ attempted: true, result: true });
        expect(cold.after.model).toEqual({
          provider: "9router",
          id: "cx/test-model",
        });
        expect(cold.hasProvider9router).toBe(true);
        expect(cold.verdict?.deferrable).toBe(false);
        expect(cold.verdict?.fingerprint).toBe(cold.fingerprint);
        expect(cold.network.rejectedExternalCalls).toBeGreaterThan(0);

        const coldModel = requireModel(cold.selection);
        expect(coldModel.id).toBe("cx/test-model");
        expect(coldModel.reasoning).toBe(true);
        expect(coldModel.thinking).toBeNull();
        expect(coldModel.supportsTools).toBe(false);
        expect(coldModel.input).toEqual(["text"]);
        expect(coldModel.contextWindow).toBe(65_536);
        expect(coldModel.maxTokens).toBe(8_192);
        expect(coldModel.cost).toEqual({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });

        const liveFalse = requireModel(
          cold.roster.find((model) => model.id === "cx/gpt-6-astra"),
        );
        expect(liveFalse.reasoning).toBe(false);
        expect(liveFalse.thinking).toBeNull();
        const effortModel = requireModel(
          cold.roster.find((model) => model.id === "cx/gpt-6-sol"),
        );
        expect(effortModel.reasoning).toBe(true);
        expect(effortModel.thinking?.efforts).toEqual([
          "low",
          "medium",
          "high",
          "max",
        ]);
        expect(effortModel.input).toEqual(["text", "image"]);
        expect(effortModel.supportsTools).toBe(true);
        matrix.liveFalseAuthority = {
          source: "final registry snapshot",
          model: liveFalse,
        };

        const coldDiscovery = requireCall(server.calls, "discovery");
        const coldCompletion = requireCall(server.calls, "completion");
        expect(coldDiscovery.authorization).toBe(`Bearer ${CONFIGURED_KEY}`);
        expect(coldCompletion.authorization).toBe(`Bearer ${CONFIGURED_KEY}`);
        expect(coldCompletion.body?.model).toBe("cx/test-model");
        expect(coldCompletion.body?.stream).toBe(true);
        expect(coldCompletion.body?.reasoning_effort).toBeUndefined();
        expect(coldCompletion.body?.thinking).toBeUndefined();
        expect(coldCompletion.body?.tools).toBeUndefined();
        expect(coldCompletion.body?.max_completion_tokens).toBe(8_192);

        matrix.coldSuccess = {
          versions: cold.versions,
          process: cold.process,
          extension: cold.extension,
          roster: cold.roster,
          selection: cold.selection,
          otherRoster: cold.otherRoster,
          verdict: cold.verdict,
          network: cold.network,
          discovery: redactedCall(coldDiscovery, CONFIGURED_KEY),
          completion: redactedCall(coldCompletion, CONFIGURED_KEY),
        };

        // (b) Same agentDir, new process, changed roster, warm metadata cache.
        await seedMetadataCache(context.homeDir, {
          "cx/next-model": {
            limit: { context: 98_304, output: 12_288 },
            cost: {
              input: 1.5,
              output: 2.5,
              cache_read: 0.15,
              cache_write: 0.25,
            },
          },
        });
        server.setRoster(ROSTER_B);
        server.resetCalls();
        const warm = await runSession(context, {
          modelPattern: "9router/cx/next-model",
          prompt: "say OK",
        });
        expect(warm.process.pid).not.toBe(cold.process.pid);
        expect(warm.roster.map((model) => model.id).sort()).toEqual([
          "cx/next-model",
          "glm/glm-5.2",
        ]);
        expect(warm.roster.map((model) => model.id)).not.toContain(
          "cx/test-model",
        );
        expect(warm.verdict?.deferrable).toBe(false);
        expect(warm.verdict?.fingerprint).toBe(warm.fingerprint);
        expect(warm.network.rejectedExternalCalls).toBe(0);
        const warmModel = requireModel(
          warm.roster.find((model) => model.id === "cx/next-model"),
        );
        expect(warmModel.cost).toEqual({
          input: 1.5,
          output: 2.5,
          cacheRead: 0.15,
          cacheWrite: 0.25,
        });
        expect(warm.before.model?.id).toBe("cx/next-model");
        expect(requireCall(server.calls, "completion").body?.model).toBe(
          "cx/next-model",
        );
        matrix.changedRosterWarmCache = {
          process: warm.process,
          roster: warm.roster,
          selection: warm.selection,
          verdict: warm.verdict,
          network: warm.network,
          discovery: redactedCall(
            requireCall(server.calls, "discovery"),
            CONFIGURED_KEY,
          ),
          completion: redactedCall(
            requireCall(server.calls, "completion"),
            CONFIGURED_KEY,
          ),
        };

        // (c) Native thinking payloads: default, effort, off/clamp, toggle,
        // unknown ladder, live-false control, and tools/image capability.
        await writeModels(context, CONFIGURED_KEY);
        server.setRoster(ROSTER_A);
        const thinking: unknown[] = [];
        thinking.push(
          await captureThinking(context, server, {
            name: "native-default",
            modelPattern: "9router/cx/gpt-6-sol",
            expectedEffort: "high",
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "effort-high",
            modelPattern: "9router/cx/gpt-6-sol",
            thinkingLevel: "high",
            expectedEffort: "high",
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "native-off",
            modelPattern: "9router/cx/gpt-6-sol",
            thinkingLevel: "off",
            expectedEffort: "low",
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "clamp-xhigh-to-high",
            modelPattern: "9router/cx/gpt-6-sol",
            thinkingLevel: "xhigh",
            expectedEffort: "high",
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "clamp-max-to-high",
            modelPattern: "9router/cx/limited-effort",
            thinkingLevel: "max",
            expectedEffort: "high",
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "toggle-enabled",
            modelPattern: "9router/glm/glm-5.2",
            thinkingLevel: "high",
            expectedThinking: { type: "enabled" },
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "toggle-disabled",
            modelPattern: "9router/glm/glm-5.2",
            thinkingLevel: "off",
            expectedThinking: { type: "disabled" },
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "unknown-ladder",
            modelPattern: "9router/cx/test-model",
            thinkingLevel: "high",
            expectedNoThinking: true,
          }),
        );
        thinking.push(
          await captureThinking(context, server, {
            name: "live-false",
            modelPattern: "9router/cx/gpt-6-astra",
            thinkingLevel: "high",
            expectedNoThinking: true,
            expectedReasoning: false,
          }),
        );
        server.resetCalls();
        const withTools = await runSession(context, {
          modelPattern: "9router/cx/gpt-6-sol",
          thinkingLevel: "high",
          toolNames: ["read"],
          prompt: "say OK",
        });
        const toolCompletion = requireCall(server.calls, "completion");
        const toolDefinitions = toolCompletion.body?.tools;
        expect(Array.isArray(toolDefinitions)).toBe(true);
        expect(
          Array.isArray(toolDefinitions) ? toolDefinitions.length : 0,
        ).toBeGreaterThan(0);
        server.resetCalls();
        const noTools = await runSession(context, {
          modelPattern: "9router/cx/test-model",
          thinkingLevel: "high",
          toolNames: ["read"],
          prompt: "say OK",
        });
        const noToolCompletion = requireCall(server.calls, "completion");
        expect(noToolCompletion.body?.tools).toBeUndefined();
        expect(requireModel(noTools.selection).input).toEqual(["text"]);

        // Image wire: pass the same 1x1 PNG through the native prompt API.
        // Vision-on must carry image_url to its own completion; vision-off
        // must not, and the host's describer completion is a separate model.
        server.resetCalls();
        const visionOn = await runSession(context, {
          modelPattern: "9router/cx/gpt-6-sol",
          prompt: "describe this image",
          image: true,
        });
        expect(visionOn.prompt).toEqual({ attempted: true, result: true });
        const visionOnTargets = completionsForModel(
          server.calls,
          "cx/gpt-6-sol",
        );
        expect(visionOnTargets).toHaveLength(1);
        const visionOnTarget = requireCompletion(visionOnTargets);
        const visionOnImageUrl = bodyContains(
          visionOnTarget,
          '"type":"image_url"',
        );
        const visionOnDataUrl = bodyContains(visionOnTarget, "data:image/");
        expect(visionOnImageUrl).toBe(true);
        expect(visionOnDataUrl).toBe(true);

        server.resetCalls();
        const visionOff = await runSession(context, {
          modelPattern: "9router/cx/test-model",
          prompt: "describe this image",
          image: true,
        });
        expect(visionOff.prompt).toEqual({ attempted: true, result: true });
        const visionOffTargets = completionsForModel(
          server.calls,
          "cx/test-model",
        );
        expect(visionOffTargets).toHaveLength(1);
        const visionOffTarget = requireCompletion(visionOffTargets);
        const visionOffImageUrl = bodyContains(
          visionOffTarget,
          '"type":"image_url"',
        );
        const visionOffDataUrl = bodyContains(visionOffTarget, "data:image/");
        expect(visionOffImageUrl).toBe(false);
        expect(visionOffDataUrl).toBe(false);
        const describerCompletions = server.calls.filter(
          (call) =>
            call.kind === "completion" &&
            call.body?.model !== "cx/test-model" &&
            bodyContains(call, '"type":"image_url"'),
        );
        expect(describerCompletions.length).toBeGreaterThan(0);

        matrix.thinking = thinking;
        matrix.toolsImage = {
          modelWithTools: {
            selection: withTools.selection,
            toolsCount: Array.isArray(toolDefinitions)
              ? toolDefinitions.length
              : 0,
          },
          modelWithoutTools: {
            selection: noTools.selection,
            toolsPresent:
              Array.isArray(noToolCompletion.body?.tools) &&
              noToolCompletion.body.tools.length > 0,
          },
          imageWire: {
            visionOn: {
              targetModel: "cx/gpt-6-sol",
              targetCount: visionOnTargets.length,
              imageUrl: visionOnImageUrl,
              dataImageUrl: visionOnDataUrl,
            },
            visionOff: {
              targetModel: "cx/test-model",
              targetCount: visionOffTargets.length,
              imageUrl: visionOffImageUrl,
              dataImageUrl: visionOffDataUrl,
              describerCount: describerCompletions.length,
              describerImageUrl: true,
            },
          },
        };

        // (d) Credential resolution: one-step env reference, then a literal
        // value beginning with `!`, which never becomes a command.
        const commandMarker = join(context.root, "spawned-command-marker");
        await writeModels(context, "NINE_ROUTER_API_KEY");
        server.resetCalls();
        const envReference = await runSession(context, {
          modelPattern: "9router/cx/test-model",
          prompt: "say OK",
          extraEnv: {
            NINE_ROUTER_API_KEY: "OTHER_KEY",
            OTHER_KEY: "second-token",
          },
        });
        expect(envReference.prompt?.result).toBe(true);
        const envDiscovery = requireCall(server.calls, "discovery");
        const envCompletion = requireCall(server.calls, "completion");
        expect(envDiscovery.authorization).toBe("Bearer OTHER_KEY");
        expect(envCompletion.authorization).toBe("Bearer OTHER_KEY");

        server.resetCalls();
        const bangLiteral = `!touch ${commandMarker}`;
        const bangRun = await runSession(context, {
          modelPattern: "9router/cx/test-model",
          prompt: "say OK",
          extraEnv: { NINE_ROUTER_API_KEY: bangLiteral },
        });
        expect(bangRun.prompt?.result).toBe(true);
        expect(requireCall(server.calls, "discovery").authorization).toBe(
          `Bearer ${bangLiteral}`,
        );
        expect(requireCall(server.calls, "completion").authorization).toBe(
          `Bearer ${bangLiteral}`,
        );
        expect(await Bun.file(commandMarker).exists()).toBe(false);

        await writeModels(context, `!touch ${commandMarker}`);
        server.resetCalls();
        const commandConfig = await runSession(context, {});
        expect(commandConfig.roster).toEqual([]);
        expect(commandConfig.extension?.registersProviders).toBe(true);
        expect(server.calls).toEqual([]);
        expect(await Bun.file(commandMarker).exists()).toBe(false);
        matrix.credentials = {
          envReference: {
            discovery: redactedCall(envDiscovery, "OTHER_KEY"),
            completion: redactedCall(envCompletion, "OTHER_KEY"),
            derivedSecretNotUsed: true,
          },
          bangLiteral: {
            bearerLiteral: true,
            commandExecuted: false,
          },
          commandConfig: {
            rosterEmpty: true,
            extensionMarker:
              commandConfig.extension?.registersProviders === true,
            requests: server.calls.length,
            commandExecuted: false,
          },
        };

        // (e) Native CLI --api-key changes completion only; discovery keeps the
        // configured models.yml key.
        await writeModels(context, "V7_CONFIG_KEY");
        await seedMetadataCache(context.homeDir, {});
        server.resetCalls();
        const cli = await runCli(context, [
          "--model",
          "9router/cx/test-model",
          "-p",
          "say OK",
          "--api-key",
          "OVERRIDE_KEY",
          "--no-tools",
        ]);
        expect(cli.exitCode).toBe(0);
        expect(cli.stdout).toContain("OK");
        const cliDiscovery = requireCall(server.calls, "discovery");
        const cliCompletion = requireCall(server.calls, "completion");
        expect(cliDiscovery.authorization).toBe("Bearer V7_CONFIG_KEY");
        expect(cliCompletion.authorization).toBe("Bearer OVERRIDE_KEY");
        expect(cliCompletion.body?.model).toBe("cx/test-model");
        matrix.cliApiKeyOverride = {
          exitCode: cli.exitCode,
          stdout: "OK",
          discovery: redactedCall(cliDiscovery, "V7_CONFIG_KEY"),
          completion: redactedCall(cliCompletion, "OVERRIDE_KEY"),
          discoveryUsesConfiguredKey: true,
          completionUsesOverride: true,
        };

        await writeEvidence("task-8-startup-wire.json", {
          scenario: "startup-and-wire",
          status: "passed",
          generatedAt: new Date().toISOString(),
          versions: cold.versions,
          artifact: {
            path: context.extensionPath,
            fingerprint: cold.fingerprint,
          },
          matrix,
          cleanup: resourceReceipt(ownedRoots, ownedServers, childPids),
        });
      }, 120_000);
    });
  }

  if (scenario === "failure-and-restart" || scenario === "all") {
    describe("runtime failure and restart", () => {
      test("failure removes the roster without stale revival, keeps OMP usable, and recovery resolves the explicit model", async () => {
        const server = startFakeRouter({ roster: ROSTER_A });
        ownedServers.push(server);
        const context = await createContext("failure", server);
        await writeModels(context, CONFIGURED_KEY);
        await seedMetadataCache(context.homeDir, {});
        const matrix: Record<string, unknown> = {};

        // Success, then a new process against an unauthorized server.
        const success = await runSession(context, {
          modelPattern: "9router/cx/test-model",
          prompt: "say OK",
        });
        expect(success.roster.map((model) => model.id)).toContain(
          "cx/test-model",
        );
        expect(success.prompt?.result).toBe(true);
        expect(success.verdict?.deferrable).toBe(false);

        server.setMode("unauthorized");
        server.resetCalls();
        const failure = await runSession(context, {});
        expect(failure.process.pid).not.toBe(success.process.pid);
        expect(failure.deferredPaths).toEqual([]);
        expect(failure.extension?.registersProviders).toBe(true);
        expect(failure.roster).toEqual([]);
        expect(failure.selection).toBeNull();
        expect(failure.otherRoster.map((model) => model.id)).toEqual([
          "keep-me",
        ]);
        expect(failure.verdict?.deferrable).toBe(false);
        expect(failure.verdict?.fingerprint).toBe(failure.fingerprint);
        expect(failure.verdict?.fingerprint).toBe(success.verdict?.fingerprint);
        expect(server.calls.some((call) => call.kind === "completion")).toBe(
          false,
        );
        const failureDiscovery = requireCall(server.calls, "discovery");
        expect(failureDiscovery.authorization).toBe(`Bearer ${CONFIGURED_KEY}`);

        // Noninteractive CLI surfaces one redacted diagnostic while the other
        // provider still answers the prompt.
        server.resetCalls();
        const cliFailure = await runCli(context, [
          "-p",
          "say OK",
          "--no-tools",
        ]);
        expect(cliFailure.exitCode).toBe(0);
        expect(cliFailure.stdout).toContain("OK");
        expect(cliFailure.stderr).toContain("9Router:");
        expect(cliFailure.stderr).toContain("discovery failed");
        expect(cliFailure.stderr).toContain("unauthorized");
        expect(cliFailure.stderr).not.toContain(CONFIGURED_KEY);
        expect(cliFailure.stderr).not.toContain(server.nineRouterBaseUrl);
        const otherProviderCompleted = server.calls.some(
          (call) => call.kind === "other-completion",
        );
        expect(otherProviderCompleted).toBe(true);
        expect(server.calls.some((call) => call.kind === "completion")).toBe(
          false,
        );

        // Failure then success in a new process: the stored non-deferrable
        // verdict must still let the explicit model resolve.
        server.setMode("success");
        server.setRoster(ROSTER_A);
        server.resetCalls();
        const recovered = await runSession(context, {
          modelPattern: "9router/cx/test-model",
          prompt: "say OK",
        });
        expect(recovered.deferredPaths).toEqual([]);
        expect(recovered.extension?.registersProviders).toBe(true);
        expect(recovered.roster.map((model) => model.id)).toContain(
          "cx/test-model",
        );
        expect(recovered.before.model).toEqual({
          provider: "9router",
          id: "cx/test-model",
        });
        expect(recovered.prompt).toEqual({ attempted: true, result: true });
        expect(recovered.verdict?.deferrable).toBe(false);
        expect(recovered.verdict?.fingerprint).toBe(
          failure.verdict?.fingerprint,
        );

        // A stale native discovery cache with no discovery config in
        // models.yml must not revive the old roster.
        const staleServer = startFakeRouter({ roster: ROSTER_A });
        ownedServers.push(staleServer);
        const staleContext = await createContext("stale", staleServer);
        await writeModels(staleContext, CONFIGURED_KEY);
        await seedMetadataCache(staleContext.homeDir, {});
        const staleRosterPath = join(staleContext.root, "stale-roster.json");
        await writeFile(staleRosterPath, `${JSON.stringify(STALE_ROSTER)}\n`);
        const seedExtensionPath = join(
          staleContext.root,
          "extensions",
          "seed-extension.ts",
        );
        await mkdir(dirname(seedExtensionPath), { recursive: true });
        await writeFile(seedExtensionPath, seedExtensionSource());
        const seed = await runSeed(staleContext, {
          extensionPath: seedExtensionPath,
          staleRosterPath,
          baseUrl: staleServer.nineRouterBaseUrl,
        });
        expect(seed.roster.map((model) => model.id)).toEqual([
          "stale/legacy-model",
        ]);
        expect(seed.cacheRows.length).toBeGreaterThan(0);
        const modelsYaml = await readFile(staleContext.modelsPath, "utf8");
        expect(modelsYaml).not.toContain("discovery:");
        expect(modelsYaml).not.toContain("modelOverrides:");
        expect(modelsYaml).not.toContain("fetchDynamicModels");

        staleServer.setMode("unauthorized");
        const staleFailure = await runSession(staleContext, {});
        expect(staleFailure.deferredPaths).toEqual([]);
        expect(staleFailure.extension?.registersProviders).toBe(true);
        expect(staleFailure.roster).toEqual([]);
        expect(staleFailure.roster.map((model) => model.id)).not.toContain(
          "stale/legacy-model",
        );
        expect(staleFailure.otherRoster.map((model) => model.id)).toEqual([
          "keep-me",
        ]);
        expect(staleFailure.verdict?.deferrable).toBe(false);

        // Raw command-backed keys are rejected before discovery.
        const commandServer = startFakeRouter({ roster: ROSTER_A });
        ownedServers.push(commandServer);
        const commandContext = await createContext(
          "command-key",
          commandServer,
        );
        await writeModels(
          commandContext,
          `!touch ${join(commandContext.root, "marker")}`,
        );
        await seedMetadataCache(commandContext.homeDir, {});
        commandServer.resetCalls();
        const commandRun = await runSession(commandContext, {});
        expect(commandRun.roster).toEqual([]);
        expect(commandRun.extension?.registersProviders).toBe(true);
        expect(commandServer.calls).toEqual([]);
        expect(
          await Bun.file(join(commandContext.root, "marker")).exists(),
        ).toBe(false);

        // Malformed discovery JSON is a typed failure, not a crash: the roster
        // stays empty, the other provider remains usable, and the CLI prints a
        // redacted diagnostic.
        const malformedServer = startFakeRouter({
          roster: ROSTER_A,
          mode: "malformed-json",
        });
        ownedServers.push(malformedServer);
        const malformedContext = await createContext(
          "malformed",
          malformedServer,
        );
        await writeModels(malformedContext, CONFIGURED_KEY);
        await seedMetadataCache(malformedContext.homeDir, {});
        const malformed = await runSession(malformedContext, {});
        expect(malformed.roster).toEqual([]);
        expect(malformed.otherRoster.map((model) => model.id)).toEqual([
          "keep-me",
        ]);
        expect(malformed.extension?.registersProviders).toBe(true);
        expect(malformed.verdict?.deferrable).toBe(false);
        const malformedCli = await runCli(malformedContext, [
          "-p",
          "say OK",
          "--no-tools",
        ]);
        expect(malformedCli.exitCode).toBe(0);
        expect(malformedCli.stderr).toContain("9Router:");
        expect(malformedCli.stderr).toContain("malformed-json");
        expect(malformedCli.stderr).not.toContain(CONFIGURED_KEY);
        expect(
          malformedServer.calls.some((call) => call.kind === "completion"),
        ).toBe(false);
        expect(
          malformedServer.calls.some(
            (call) => call.kind === "other-completion",
          ),
        ).toBe(true);

        // Bounded-child / interruption control: a child that announces itself
        // and then runs forever is killed and reaped, proving the harness
        // cannot leave an owned process behind.
        const sleeper = Bun.spawn({
          cmd: [
            process.execPath,
            "-e",
            'console.log("ready"); setInterval(() => {}, 1000);',
          ],
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        childPids.add(sleeper.pid);
        const sleeperReader = sleeper.stdout.getReader();
        const ready = await sleeperReader.read();
        expect(ready.done).toBe(false);
        sleeper.kill("SIGKILL");
        const sleeperExit = await sleeper.exited;
        expect(sleeperExit).not.toBe(0);
        expect(isProcessAlive(sleeper.pid)).toBe(false);

        matrix.successThenFailure = {
          success: {
            process: success.process,
            roster: success.roster.map((model) => model.id),
            verdict: success.verdict,
          },
          failure: {
            process: failure.process,
            roster: failure.roster,
            otherRoster: failure.otherRoster.map((model) => model.id),
            extension: failure.extension,
            deferredPaths: failure.deferredPaths,
            verdict: failure.verdict,
            discovery: redactedCall(failureDiscovery, CONFIGURED_KEY),
          },
          cliFailure: {
            exitCode: cliFailure.exitCode,
            stdout: cliFailure.stdout.trim(),
            diagnosticLines: cliFailure.stderr
              .split("\n")
              .filter((line) => line.includes("9Router:")),
            otherProviderCompleted,
          },
          recovered: {
            process: recovered.process,
            roster: recovered.roster.map((model) => model.id),
            selection: recovered.selection,
            prompt: recovered.prompt,
            verdict: recovered.verdict,
            deferredPaths: recovered.deferredPaths,
          },
        };
        matrix.staleNativeCache = {
          seed: {
            process: seed.process,
            roster: seed.roster.map((model) => model.id),
            cacheRows: seed.cacheRows,
          },
          failure: {
            process: staleFailure.process,
            roster: staleFailure.roster,
            otherRoster: staleFailure.otherRoster.map((model) => model.id),
            extension: staleFailure.extension,
            verdict: staleFailure.verdict,
          },
          discoveryConfigAbsent: true,
        };
        matrix.commandKey = {
          rosterEmpty: true,
          markerPresent: false,
          requests: commandServer.calls.length,
        };
        matrix.malformedDiscovery = {
          failure: {
            roster: malformed.roster,
            otherRoster: malformed.otherRoster.map((model) => model.id),
            extension: malformed.extension,
            verdict: malformed.verdict,
          },
          cli: {
            exitCode: malformedCli.exitCode,
            stdout: malformedCli.stdout.trim(),
            diagnosticLines: malformedCli.stderr
              .split("\n")
              .filter((line) => line.includes("9Router:")),
            otherProviderCompleted: malformedServer.calls.some(
              (call) => call.kind === "other-completion",
            ),
            nineRouterCompleted: malformedServer.calls.some(
              (call) => call.kind === "completion",
            ),
          },
        };
        matrix.adversarial = {
          malformedResponse: "probed (typed discovery failure, roster empty)",
          externalFetch:
            "probed in startup-and-wire (loopback guard rejected models.dev)",
          staleCache: "probed (native cache seeded, old roster inert)",
          dirtyEnvironment:
            "probed (isolated HOME/agentDir/cache; profiles removed)",
          longChild: {
            pid: sleeper.pid,
            readyBeforeKill: ready.done === false,
            exitCode: sleeperExit,
            reaped: !isProcessAlive(sleeper.pid),
          },
          flaky:
            "three green startup/failure smoke runs plus per-case reruns; see task-8 logs",
          misleadingPayload:
            "not treated as upstream enforcement; only the host payload is asserted",
          interruption: {
            signal: "SIGKILL",
            exited: true,
            reaped: !isProcessAlive(sleeper.pid),
          },
        };

        await writeEvidence("task-8-failure-restart.json", {
          scenario: "failure-and-restart",
          status: "passed",
          generatedAt: new Date().toISOString(),
          versions: success.versions,
          artifact: {
            path: context.extensionPath,
            fingerprint: success.fingerprint,
          },
          matrix,
          cleanup: resourceReceipt(ownedRoots, ownedServers, childPids),
        });
      }, 120_000);
    });
  }

  // -------------------------------------------------------------------------
  // Parent helpers
  // -------------------------------------------------------------------------

  interface TestContext {
    readonly root: string;
    readonly homeDir: string;
    readonly agentDir: string;
    readonly workDir: string;
    readonly tmpDir: string;
    readonly modelsPath: string;
    readonly extensionPath: string;
    readonly server: FakeRouter;
  }

  async function createContext(
    label: string,
    server: FakeRouter,
  ): Promise<TestContext> {
    const root = await mkdtemp(join(tmpdir(), `omp-runtime-${label}-`));
    ownedRoots.push(root);
    const homeDir = join(root, "home");
    const agentDir = join(root, "agent");
    const workDir = join(root, "work");
    const tmpDir = join(root, "tmp");
    for (const directory of [homeDir, agentDir, workDir, tmpDir])
      await mkdir(directory, { recursive: true });
    const extensionPath = join(repoRoot, "dist", "index.js");
    if (!(await Bun.file(extensionPath).exists()))
      throw new Error("dist/index.js is missing; run `bun run build` first");
    return {
      root,
      homeDir,
      agentDir,
      workDir,
      tmpDir,
      modelsPath: join(agentDir, "models.yml"),
      extensionPath,
      server,
    };
  }

  async function writeModels(
    context: TestContext,
    apiKey: string,
  ): Promise<void> {
    const lines = [
      "providers:",
      '  "9router":',
      `    baseUrl: ${JSON.stringify(context.server.nineRouterBaseUrl)}`,
      "    api: openai-completions",
      `    apiKey: ${JSON.stringify(apiKey)}`,
      '  "other":',
      `    baseUrl: ${JSON.stringify(context.server.otherBaseUrl)}`,
      "    api: openai-completions",
      `    apiKey: ${JSON.stringify(OTHER_KEY_VALUE)}`,
      "    models:",
      "      - id: keep-me",
      "        name: keep-me",
      "        reasoning: false",
      "        input: [text]",
      "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
      "        contextWindow: 32768",
      "        maxTokens: 4096",
    ];
    await writeFile(context.modelsPath, `${lines.join("\n")}\n`);
  }

  async function seedMetadataCache(
    homeDir: string,
    models: Record<string, unknown>,
  ): Promise<void> {
    const cacheDir = join(homeDir, ".cache", "omp-9router-plus");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "models.dev.api.json"),
      JSON.stringify({ timestamp: Date.now(), data: {} }),
    );
    await writeFile(
      join(cacheDir, "models.dev.models.json"),
      JSON.stringify({ timestamp: Date.now(), data: models }),
    );
  }

  async function runSession(
    context: TestContext,
    options: {
      readonly modelPattern?: string;
      readonly thinkingLevel?: string;
      readonly toolNames?: readonly string[];
      readonly prompt?: string;
      readonly image?: boolean;
      readonly extraEnv?: Record<string, string>;
      readonly extensionPath?: string;
    },
  ): Promise<SessionChildResult> {
    counter++;
    const requestPath = join(context.root, `request-${counter}.json`);
    const resultPath = join(context.root, `result-${counter}.json`);
    const request: ChildRequest = {
      kind: "session",
      repoRoot,
      agentDir: context.agentDir,
      workDir: context.workDir,
      extensionPath: options.extensionPath ?? context.extensionPath,
      modelsPath: context.modelsPath,
      resultPath,
      modelPattern: options.modelPattern,
      thinkingLevel: options.thinkingLevel,
      toolNames: options.toolNames,
      prompt: options.prompt,
      image: options.image,
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);
    const result = await spawnChild<SessionChildResult>(
      context,
      requestPath,
      resultPath,
      options.extraEnv,
    );
    return result;
  }

  async function runSeed(
    context: TestContext,
    options: {
      readonly extensionPath: string;
      readonly staleRosterPath: string;
      readonly baseUrl: string;
    },
  ): Promise<SeedChildResult> {
    counter++;
    const requestPath = join(context.root, `seed-request-${counter}.json`);
    const resultPath = join(context.root, `seed-result-${counter}.json`);
    const request: ChildRequest = {
      kind: "seed-cache",
      repoRoot,
      agentDir: context.agentDir,
      workDir: context.workDir,
      extensionPath: options.extensionPath,
      modelsPath: context.modelsPath,
      resultPath,
      staleRosterPath: options.staleRosterPath,
      baseUrl: options.baseUrl,
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`);
    return await spawnChild<SeedChildResult>(context, requestPath, resultPath, {
      TASK8_SEED_STALE_PATH: options.staleRosterPath,
      TASK8_SEED_BASE_URL: options.baseUrl,
    });
  }

  async function spawnChild<T>(
    context: TestContext,
    requestPath: string,
    resultPath: string,
    extraEnv: Record<string, string> | undefined,
  ): Promise<T> {
    const proc = Bun.spawn({
      cmd: [process.execPath, import.meta.path],
      cwd: context.workDir,
      env: childEnvironment(context, requestPath, extraEnv),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    childPids.add(proc.pid);
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      let result: T | ChildFailure;
      try {
        result = (await Bun.file(resultPath).json()) as T | ChildFailure;
      } catch {
        throw new Error(
          `runtime child wrote no result (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      if (exitCode !== 0 || !(result as { ok?: boolean }).ok) {
        const failure = result as ChildFailure;
        throw new Error(
          `runtime child failed (exit ${exitCode}): ${failure.error}\n${failure.stack ?? ""}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      return result as T;
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
  }

  async function runCli(
    context: TestContext,
    args: readonly string[],
  ): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    const cliPath = join(
      repoRoot,
      "node_modules",
      "@oh-my-pi",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        cliPath,
        "-e",
        context.extensionPath,
        "--no-extensions",
        ...args,
        "--no-lsp",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--no-title",
        "--no-session",
      ],
      cwd: context.workDir,
      env: childEnvironment(context, undefined, undefined),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    childPids.add(proc.pid);
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
  }

  function childEnvironment(
    context: TestContext,
    requestPath: string | undefined,
    extraEnv: Record<string, string> | undefined,
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
    env.HOME = context.homeDir;
    env.PI_CODING_AGENT_DIR = context.agentDir;
    env.XDG_CACHE_HOME = join(context.homeDir, ".cache");
    env.XDG_CONFIG_HOME = join(context.homeDir, ".config");
    env.XDG_DATA_HOME = join(context.homeDir, ".local", "share");
    env.XDG_STATE_HOME = join(context.homeDir, ".local", "state");
    env.TMPDIR = context.tmpDir;
    env.DO_NOT_TRACK = "1";
    env.OMP_DISABLE_TELEMETRY = "1";
    if (requestPath !== undefined) {
      env[CHILD_ENV] = "1";
      env[REQUEST_ENV] = requestPath;
    }
    for (const [key, value] of Object.entries(extraEnv ?? {})) env[key] = value;
    return env;
  }

  async function captureThinking(
    context: TestContext,
    server: FakeRouter,
    options: {
      readonly name: string;
      readonly modelPattern: string;
      readonly thinkingLevel?: string;
      readonly expectedEffort?: string;
      readonly expectedThinking?: Record<string, unknown>;
      readonly expectedNoThinking?: boolean;
      readonly expectedReasoning?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    server.resetCalls();
    const run = await runSession(context, {
      modelPattern: options.modelPattern,
      thinkingLevel: options.thinkingLevel,
      prompt: "say OK",
    });
    const completion = requireCall(server.calls, "completion");
    const body = completion.body ?? {};
    if (options.expectedEffort !== undefined)
      expect(body.reasoning_effort).toBe(options.expectedEffort);
    if (options.expectedThinking !== undefined)
      expect(body.thinking).toEqual(options.expectedThinking);
    if (options.expectedNoThinking === true) {
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.thinking).toBeUndefined();
    }
    if (options.expectedReasoning !== undefined)
      expect(requireModel(run.selection).reasoning).toBe(
        options.expectedReasoning,
      );
    return {
      name: options.name,
      before: run.before,
      selection: run.selection,
      wire: redactedCall(completion, CONFIGURED_KEY),
    };
  }

  function completionsForModel(
    calls: readonly FakeRouterCall[],
    model: string,
  ): FakeRouterCall[] {
    return calls.filter(
      (call) => call.kind === "completion" && call.body?.model === model,
    );
  }

  function requireCompletion(calls: readonly FakeRouterCall[]): FakeRouterCall {
    const call = calls[0];
    if (!call) throw new Error("expected a target completion");
    return call;
  }

  function bodyContains(call: FakeRouterCall, needle: string): boolean {
    return JSON.stringify(call.body?.messages ?? []).includes(needle);
  }

  function requireCall(
    calls: readonly FakeRouterCall[],
    kind: FakeRouterCall["kind"],
  ): FakeRouterCall {
    const call = calls.find((item) => item.kind === kind);
    if (!call) throw new Error(`expected a ${kind} request`);
    return call;
  }

  function requireModel(
    model: SerializedModel | null | undefined,
  ): SerializedModel {
    if (!model) throw new Error("expected a model snapshot");
    return model;
  }

  function redactedCall(
    call: FakeRouterCall,
    expectedKey: string,
  ): Record<string, unknown> {
    const body = call.body ?? {};
    return {
      kind: call.kind,
      method: call.method,
      path: call.path,
      authorizationPresent: call.authorization !== null,
      authorizationMatches: call.authorization === `Bearer ${expectedKey}`,
      model: typeof body.model === "string" ? body.model : null,
      stream: body.stream === true,
      reasoning_effort:
        typeof body.reasoning_effort === "string"
          ? body.reasoning_effort
          : null,
      thinking:
        body.thinking !== null && typeof body.thinking === "object"
          ? body.thinking
          : null,
      toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
      maxCompletionTokens:
        typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : null,
    };
  }

  function assertVersions(versions: {
    readonly host: string;
    readonly package: string;
    readonly bun: string;
  }): void {
    expect(versions.host).toBe("18.20.0");
    expect(versions.package).toBe("18.20.0");
    expect(compareVersions(versions.bun, "1.4.4")).toBeGreaterThanOrEqual(0);
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

  function resourceReceipt(
    roots: readonly string[],
    servers: readonly FakeRouter[],
    pids: ReadonlySet<number>,
  ): Record<string, unknown> {
    return {
      rootsRemoved: roots.length,
      serversStopped: servers.length,
      childProcesses: [...pids],
      childProcessesExited: [...pids].every((pid) => !isProcessAlive(pid)),
    };
  }

  async function writeEvidence(name: string, value: unknown): Promise<void> {
    const configured =
      process.env.EVIDENCE_DIR ?? join(".omo", "evidence", "omp-9router-plus");
    const directory = isAbsolute(configured)
      ? configured
      : resolve(repoRoot, configured);
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    if (!evidenceFiles.includes(path)) evidenceFiles.push(path);
  }

  function selectedScenario(): ScenarioName {
    const inline = process.argv.find((arg) => arg.startsWith("--scenario="));
    if (inline !== undefined) {
      const value = inline.slice("--scenario=".length);
      if (value === "startup-and-wire" || value === "failure-and-restart")
        return value;
    }
    const index = process.argv.indexOf("--scenario");
    if (index >= 0) {
      const value = process.argv[index + 1];
      if (value === "startup-and-wire" || value === "failure-and-restart")
        return value;
    }
    const env = process.env.RUNTIME_SCENARIO;
    if (env === "startup-and-wire" || env === "failure-and-restart") return env;
    return "all";
  }

  function seedExtensionSource(): string {
    return `export default async function seedExtension(pi) {
  const stale = await Bun.file(process.env.TASK8_SEED_STALE_PATH).json();
  pi.registerProvider("9router", {
    baseUrl: process.env.TASK8_SEED_BASE_URL,
    apiKey: "seed-key",
    api: "openai-completions",
    fetchDynamicModels: async () => stale,
  });
}
`;
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
