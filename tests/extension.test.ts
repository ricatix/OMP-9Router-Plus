// allow: SIZE_OK - plan task 7 pins one extension factory test file (startup
// ordering + failure matrix) beside src/index.ts; splitting would add
// out-of-scope files.
/**
 * Task 7 factory tests. Config and discovery run for real (models.yml fixture +
 * loopback HTTP); models.dev is injected. The fake host is a narrow structural
 * view of ExtensionAPI, so these tests prove factory ordering and effects, not
 * native host runtime behavior (task 8 owns that).
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionFactory,
  ProviderConfig,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import type { DiscoveryEntry, DiscoveryResult } from "../src/discovery.js";
import type {
  NineRouterExtension,
  NineRouterExtensionApi,
  NineRouterExtensionContext,
  NineRouterExtensionDeps,
} from "../src/index.js";
import type { ModelsDevClient } from "../src/models-dev.js";

// Isolate HOME/agentDir before any src/host module loads: the host root reads
// $HOME/.env and the agent .env at import time.
const isolatedHome = mkdtempSync(join(tmpdir(), "omp-extension-env-"));
const savedEnv = new Map(
  [
    "HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "PI_CODING_AGENT_DIR",
  ].map((key) => [key, process.env[key]] as const),
);
process.env.HOME = join(isolatedHome, "home");
process.env.XDG_CACHE_HOME = join(isolatedHome, "cache");
process.env.XDG_CONFIG_HOME = join(isolatedHome, "config");
process.env.XDG_DATA_HOME = join(isolatedHome, "data");
process.env.PI_CODING_AGENT_DIR = join(isolatedHome, "agent");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

/**
 * models.dev is a public network dependency the factory resolves lazily and
 * swallows failures for, so a rejected fetch alone still reports green. Record
 * every non-loopback attempt and fail the test that made it; loopback discovery
 * fixtures pass through untouched.
 */
const publicFetchAttempts: string[] = [];
const originalFetch = globalThis.fetch;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const requestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const href = requestUrl(input);
  if (!loopbackHosts.has(new URL(href).hostname)) {
    publicFetchAttempts.push(href);
    return Promise.reject(
      new Error(`blocked non-loopback fetch during extension tests: ${href}`),
    );
  }
  return originalFetch(input, init);
}) as typeof fetch;

const module = await import("../src/index.js");
const config = await import("../src/config.js");

const DISCOVERY_TOKEN_ENV = "TASK7_DISCOVERY_TOKEN";
const DISCOVERY_TOKEN = "task7-discovery-secret";

interface RecordedRegistration {
  readonly name: string;
  readonly config: ProviderConfig;
}

interface FakeHost {
  readonly api: NineRouterExtensionApi;
  readonly registrations: RecordedRegistration[];
  readonly handlers: ((
    event: { readonly type: "session_start" },
    ctx: NineRouterExtensionContext,
  ) => void | Promise<void>)[];
}

interface FixtureServer {
  readonly baseUrl: string;
  readonly authorizations: (string | null)[];
  /** Replaces the served roster for the next request. */
  setRoster(roster: readonly unknown[]): void;
  stop(): void;
}

const roots: string[] = [];
const servers: FixtureServer[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop();
  expect(publicFetchAttempts.splice(0)).toEqual([]);
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const root of [...roots, isolatedHome])
    await rm(root, { recursive: true, force: true });
  delete process.env[DISCOVERY_TOKEN_ENV];
  // Sibling suites run in this same process: leave their environment as found.
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createFakeHost(order: string[]): FakeHost {
  const registrations: RecordedRegistration[] = [];
  const handlers: FakeHost["handlers"] = [];
  const api: NineRouterExtensionApi = {
    registerProvider(name, providerConfig) {
      order.push(providerConfig.models === undefined ? "marker" : "roster");
      registrations.push({ name, config: providerConfig });
    },
    on(_event, handler) {
      handlers.push(handler);
    },
  };
  return { api, registrations, handlers };
}

function connectionFor(baseUrl: string): NineRouterExtensionDeps {
  return {
    readConnection: async () => ({
      ok: true,
      connection: {
        providerId: "9router",
        baseUrl,
        api: "openai-completions",
        apiKeyConfig: "task7-literal-key",
        resolvedApiKey: "task7-literal-key",
      },
    }),
  };
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omp-extension-${label}-`));
  roots.push(root);
  return root;
}

async function serveRoster(
  roster: readonly unknown[] | "unauthorized",
  order: string[],
  delayMs = 0,
): Promise<FixtureServer> {
  const authorizations: (string | null)[] = [];
  let current = roster;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      authorizations.push(request.headers.get("authorization"));
      order.push("request");
      if (delayMs > 0) await Bun.sleep(delayMs);
      if (current === "unauthorized")
        return new Response("unauthorized", { status: 401 });
      return Response.json(current);
    },
  });
  const fixture: FixtureServer = {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    authorizations,
    setRoster(next) {
      current = next;
    },
    stop: () => server.stop(true),
  };
  servers.push(fixture);
  return fixture;
}

async function writeModelsYaml(
  provider: Record<string, unknown>,
): Promise<string> {
  const agentDir = join(await tempRoot("models"), "agent");
  await mkdir(agentDir, { recursive: true });
  const lines = ["providers:", '  "9router":'];
  for (const [key, value] of Object.entries(provider))
    lines.push(`    ${key}: ${JSON.stringify(value)}`);
  await writeFile(join(agentDir, "models.yml"), `${lines.join("\n")}\n`);
  return agentDir;
}

function offlineModelsDev(): ModelsDevClient {
  return {
    async lookupCanonical() {
      throw new Error("metadata offline");
    },
    async lookupExact() {
      throw new Error("metadata offline");
    },
    async lookupUniqueLeaf() {
      throw new Error("metadata offline");
    },
  };
}

/**
 * Offline metadata is the default for every factory here: the production
 * client fetches models.dev and writes its cache, which the egress guard makes
 * an isolation failure. A test that needs different metadata overrides it.
 */
function extensionFor(deps: NineRouterExtensionDeps = {}): NineRouterExtension {
  return module.createNineRouterExtension({
    modelsDev: offlineModelsDev(),
    ...deps,
  });
}

function entry(id: string): DiscoveryEntry {
  return { id, kind: "llm", live: {} };
}

/** The public type omits `supportsTools`; the runtime field is read via `in`. */
function supportsToolsOf(model: ProviderModelConfig): boolean | undefined {
  if (!("supportsTools" in model)) return undefined;
  return typeof model.supportsTools === "boolean"
    ? model.supportsTools
    : undefined;
}

function sessionStart(
  host: FakeHost,
  ctx: NineRouterExtensionContext,
): Promise<void> {
  return Promise.resolve(host.handlers[0]?.({ type: "session_start" }, ctx));
}

function uiContext(notifications: string[]): NineRouterExtensionContext {
  return {
    hasUI: true,
    ui: {
      notify(message) {
        notifications.push(message);
      },
    },
  };
}

describe("startup order and eager marker", () => {
  test("startup order: marker, then discovery, then one roster with exact live IDs and raw key", async () => {
    process.env[DISCOVERY_TOKEN_ENV] = DISCOVERY_TOKEN;
    const order: string[] = [];
    const fixture = await serveRoster(
      [
        { id: "cx/test-model", name: "Test Model" },
        {
          id: "cx/live-false",
          capabilities: { reasoning: true, tools: false },
        },
      ],
      order,
      20,
    );
    const agentDir = await writeModelsYaml({
      baseUrl: fixture.baseUrl,
      api: "openai-completions",
      apiKey: DISCOVERY_TOKEN_ENV,
    });
    const host = createFakeHost(order);
    const factory = extensionFor({
      readConnection: () => config.readNineRouterConnection({ agentDir }),
    });

    await factory(host.api);

    expect(order).toEqual(["marker", "request", "roster"]);
    const roster = host.registrations[1]?.config;
    expect(roster?.baseUrl).toBe(fixture.baseUrl);
    expect(roster?.api).toBe("openai-completions");
    // The raw models.yml value crosses to the host; the resolved secret stays
    // discovery-only.
    expect(roster?.apiKey).toBe(DISCOVERY_TOKEN_ENV);
    expect(roster?.models?.map((model) => model.id)).toEqual([
      "cx/test-model",
      "cx/live-false",
    ]);
    expect(fixture.authorizations).toEqual([`Bearer ${DISCOVERY_TOKEN}`]);
    expect(host.registrations[0]?.config.models).toBeUndefined();
    expect(host.handlers).toHaveLength(1);
  });

  test("startup order: the same endpoint is re-read on every startup (no roster reuse)", async () => {
    const order: string[] = [];
    const fixture = await serveRoster([{ id: "cx/first" }], order);
    const firstHost = createFakeHost(order);
    const secondHost = createFakeHost(order);
    // The host imports a factory once and binds it to each session, so the same
    // instance must re-discover rather than reuse its first roster.
    const factory = extensionFor(connectionFor(fixture.baseUrl));

    await factory(firstHost.api);
    fixture.setRoster([{ id: "cx/second" }, { id: "cx/second-new" }]);
    await factory(secondHost.api);

    expect(
      firstHost.registrations[1]?.config.models?.map((model) => model.id),
    ).toEqual(["cx/first"]);
    expect(
      secondHost.registrations[1]?.config.models?.map((model) => model.id),
    ).toEqual(["cx/second", "cx/second-new"]);
    // One discovery request per startup, both against the same baseUrl.
    expect(fixture.authorizations).toHaveLength(2);
  });

  test("default export satisfies ExtensionFactory", () => {
    const factory: ExtensionFactory = module.default;
    expect(typeof factory).toBe("function");
  });
});

describe("failure boundaries", () => {
  test("failure: unsupported config keys resolve with marker only and one redacted UI notice", async () => {
    const secret = "task7-unsupported-secret";
    const agentDir = await writeModelsYaml({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "task7-literal-key",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const host = createFakeHost([]);
    const notices: string[] = [];

    await extensionFor({
      readConnection: () => config.readNineRouterConnection({ agentDir }),
    })(host.api);

    expect(host.registrations).toHaveLength(1);
    expect(host.registrations[0]?.config.models).toBeUndefined();
    expect(host.registrations[0]?.name).toBe("9router");

    await sessionStart(host, uiContext(notices));
    await sessionStart(host, uiContext(notices));

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("unsupported keys");
    expect(notices[0]).not.toContain(secret);
  });

  test("failure: discovery 401 resolves with marker only and one redacted stderr line", async () => {
    process.env[DISCOVERY_TOKEN_ENV] = DISCOVERY_TOKEN;
    const fixture = await serveRoster("unauthorized", []);
    const agentDir = await writeModelsYaml({
      baseUrl: fixture.baseUrl,
      apiKey: DISCOVERY_TOKEN_ENV,
    });
    const host = createFakeHost([]);
    const lines: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        lines.push(String(chunk));
        return true;
      },
    );
    try {
      await extensionFor({
        readConnection: () => config.readNineRouterConnection({ agentDir }),
      })(host.api);
      expect(host.registrations).toHaveLength(1);
      expect(host.registrations[0]?.config.models).toBeUndefined();
      const headless: NineRouterExtensionContext = {
        hasUI: false,
        ui: { notify() {} },
      };
      await sessionStart(host, headless);
      await sessionStart(host, headless);
    } finally {
      stderr.mockRestore();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unauthorized");
    expect(lines[0]).not.toContain(DISCOVERY_TOKEN);
    expect(lines[0]).not.toContain(fixture.baseUrl);
    expect(lines[0]).toContain("9Router");
  });

  test("failure: a failing startup after a successful one keeps no stale roster", async () => {
    const order: string[] = [];
    const success = await serveRoster([{ id: "cx/previous" }], order);
    const failure = await serveRoster("unauthorized", order);
    const successHost = createFakeHost(order);
    const failureHost = createFakeHost(order);

    await extensionFor(connectionFor(success.baseUrl))(successHost.api);
    await extensionFor(connectionFor(failure.baseUrl))(failureHost.api);

    expect(successHost.registrations[1]?.config.models).toHaveLength(1);
    expect(failureHost.registrations).toHaveLength(1);
    expect(failureHost.registrations[0]?.config.models).toBeUndefined();
  });

  test("failure: a missing models.yml resolves with marker only", async () => {
    const host = createFakeHost([]);
    await extensionFor({
      readConnection: () =>
        config.readNineRouterConnection({
          agentDir: join(isolatedHome, "absent-agent"),
        }),
    })(host.api);

    expect(host.registrations).toHaveLength(1);
    expect(host.registrations[0]?.config.models).toBeUndefined();
  });

  test("failure: metadata lookup errors are nonfatal and live false stays false", async () => {
    const order: string[] = [];
    const fixture = await serveRoster(
      [
        { id: "cx/alpha", capabilities: { reasoning: true, tools: false } },
        { id: "cx/beta" },
      ],
      order,
    );
    const host = createFakeHost(order);

    await extensionFor({
      ...connectionFor(fixture.baseUrl),
      modelsDev: offlineModelsDev(),
    })(host.api);

    const models = host.registrations[1]?.config.models;
    expect(models?.map((model) => model.id)).toEqual(["cx/alpha", "cx/beta"]);
    const alpha = models?.[0];
    expect(alpha?.reasoning).toBe(true);
    expect(alpha === undefined ? undefined : supportsToolsOf(alpha)).toBe(
      false,
    );
    expect(alpha?.input).toEqual(["text"]);
    expect(alpha?.api).toBe("openai-completions");
  });

  test("failure: invalid mapped models are dropped before the host queue sees them", async () => {
    const host = createFakeHost([]);
    const notices: string[] = [];
    const discover = async (): Promise<DiscoveryResult> => ({
      ok: true,
      entries: [entry("cx/valid"), entry("x".repeat(600))],
    });

    await extensionFor({
      ...connectionFor("http://127.0.0.1:20128/v1"),
      discover,
    })(host.api);
    await sessionStart(host, uiContext(notices));

    expect(
      host.registrations[1]?.config.models?.map((model) => model.id),
    ).toEqual(["cx/valid"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("1");
    expect(notices[0]).toContain("invalid");
  });

  test("failure: an all-invalid roster registers no models and reports once", async () => {
    const host = createFakeHost([]);
    const notices: string[] = [];

    await extensionFor({
      ...connectionFor("http://127.0.0.1:20128/v1"),
      discover: async () => ({
        ok: true,
        entries: [entry("x".repeat(600)), entry("y".repeat(700))],
      }),
    })(host.api);
    await sessionStart(host, uiContext(notices));

    expect(host.registrations).toHaveLength(1);
    expect(host.registrations[0]?.config.models).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("invalid");
  });

  test("failure: a throwing mapper never rejects the factory or leaks its message", async () => {
    const host = createFakeHost([]);
    const lines: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        lines.push(String(chunk));
        return true;
      },
    );
    // A roster shape the mapper cannot satisfy exercises the last-resort
    // catch, not just the per-step handlers.
    const broken = new Proxy([] as DiscoveryEntry[], {
      get(target, property, receiver) {
        if (property === Symbol.iterator)
          throw new Error("boom task7-iterator-secret");
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      await expect(
        extensionFor({
          ...connectionFor("http://127.0.0.1:20128/v1"),
          discover: async () => ({ ok: true, entries: broken }),
        })(host.api),
      ).resolves.toBeUndefined();
      await sessionStart(host, { hasUI: false, ui: { notify() {} } });
    } finally {
      stderr.mockRestore();
    }

    expect(host.registrations).toHaveLength(1);
    expect(host.registrations[0]?.config.models).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unexpectedly");
    expect(lines[0]).not.toContain("task7-iterator-secret");
  });

  test("failure: a throwing reader never rejects the factory or leaks its message", async () => {
    const host = createFakeHost([]);
    const lines: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        lines.push(String(chunk));
        return true;
      },
    );
    try {
      await expect(
        extensionFor({
          readConnection: async () => {
            throw new Error("boom task7-secret");
          },
        })(host.api),
      ).resolves.toBeUndefined();
      await sessionStart(host, { hasUI: false, ui: { notify() {} } });
    } finally {
      stderr.mockRestore();
    }

    expect(host.registrations).toHaveLength(1);
    expect(host.registrations[0]?.config.models).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("task7-secret");
  });
});
