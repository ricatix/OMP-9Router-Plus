// allow: SIZE_OK - task 2 authorizes exactly one config test file; all fixtures are inline temp files.
/**
 * Boundary tests for the models.yml connection reader. Every fixture lives in
 * a task-owned temporary agent directory; the reader must never write, read
 * `.env`, execute commands, or leak key material in diagnostics.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type NineRouterConfigError,
  type ReadNineRouterConnectionResult,
  readNineRouterConnection,
} from "../src/config.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_IMPORT_URL = new URL("../src/config.ts", import.meta.url).href;
const MAX_BYTES = 1024 * 1024;
const tempDirs: string[] = [];
const envSnapshot = new Map<string, string | undefined>();

function makeAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omp-9router-config-")).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
}

function providerConfig(overrides: Record<string, unknown> = {}): string {
  const provider: Record<string, unknown> = {
    baseUrl: "http://localhost:20128/v1",
    apiKey: "sk-test-token",
    ...overrides,
  };
  const lines = Object.entries(provider).map(
    ([key, value]) => `    ${key}: ${JSON.stringify(value)}`,
  );
  return `providers:\n  9router:\n${lines.join("\n")}\n`;
}

async function writeModels(dir: string, contents: string): Promise<string> {
  const path = join(dir, "models.yml");
  await writeFile(path, contents, "utf8");
  return path;
}

function load(dir: string): Promise<ReadNineRouterConnectionResult> {
  return readNineRouterConnection({ agentDir: dir });
}

function expectFailure(
  result: ReadNineRouterConnectionResult,
): NineRouterConfigError {
  if (result.ok) throw new Error("expected the config reader to fail");
  return result.error;
}

function expectConnection(result: ReadNineRouterConnectionResult) {
  if (!result.ok)
    throw new Error(
      `expected a connection, got ${result.error.code}: ${result.error.message}`,
    );
  return result.connection;
}

function setEnv(name: string, value: string | undefined): void {
  if (!envSnapshot.has(name)) envSnapshot.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  for (const [name, value] of envSnapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envSnapshot.clear();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("9router connection reader", () => {
  test("reads a connection from a custom agent directory", async () => {
    const dir = await makeAgentDir();
    const path = await writeModels(dir, providerConfig());
    const before = await readFile(path);

    const connection = expectConnection(await load(dir));

    expect(connection.providerId).toBe("9router");
    expect(connection.baseUrl).toBe("http://localhost:20128/v1");
    expect(connection.api).toBe("openai-completions");
    expect(connection.apiKeyConfig).toBe("sk-test-token");
    expect(connection.resolvedApiKey).toBe("sk-test-token");
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(dir)).toEqual(["models.yml"]);
  });

  test("resolves the connection api key through the environment exactly once", async () => {
    const dir = await makeAgentDir();
    await writeModels(dir, providerConfig({ apiKey: "NINE_ROUTER_API_KEY" }));
    setEnv("NINE_ROUTER_API_KEY", "OTHER_KEY");
    setEnv("OTHER_KEY", "second-token");

    const connection = expectConnection(await load(dir));

    expect(connection.apiKeyConfig).toBe("NINE_ROUTER_API_KEY");
    expect(connection.resolvedApiKey).toBe("OTHER_KEY");
    expect(connection.resolvedApiKey).not.toBe("second-token");
  });

  test("falls back to the literal when the referenced environment value is empty", async () => {
    const dir = await makeAgentDir();
    await writeModels(dir, providerConfig({ apiKey: "EMPTY_ROUTER_KEY" }));
    setEnv("EMPTY_ROUTER_KEY", "");

    const connection = expectConnection(await load(dir));

    expect(connection.apiKeyConfig).toBe("EMPTY_ROUTER_KEY");
    expect(connection.resolvedApiKey).toBe("EMPTY_ROUTER_KEY");
  });

  test("normalizes trailing slashes for endpoint construction only", async () => {
    const dir = await makeAgentDir();
    await writeModels(
      dir,
      providerConfig({ baseUrl: "https://router.example.com/v1//" }),
    );

    const connection = expectConnection(await load(dir));

    expect(connection.baseUrl).toBe("https://router.example.com/v1");
  });

  test("defaults api to openai-completions and accepts an explicit value", async () => {
    const dir = await makeAgentDir();
    await writeModels(dir, providerConfig({ api: "openai-completions" }));
    expect(expectConnection(await load(dir)).api).toBe("openai-completions");

    const dirWithoutApi = await makeAgentDir();
    await writeModels(dirWithoutApi, providerConfig());
    expect(expectConnection(await load(dirWithoutApi)).api).toBe(
      "openai-completions",
    );
  });

  test("does not cache stale config or environment state between connection reads", async () => {
    const dir = await makeAgentDir();
    await writeModels(
      dir,
      providerConfig({
        baseUrl: "http://localhost:20128/v1",
        apiKey: "STALE_ROUTER_KEY",
      }),
    );
    setEnv("STALE_ROUTER_KEY", "first-token");
    expect(expectConnection(await load(dir)).resolvedApiKey).toBe(
      "first-token",
    );

    await writeModels(
      dir,
      providerConfig({
        baseUrl: "http://localhost:20129/v2",
        apiKey: "STALE_ROUTER_KEY",
      }),
    );
    setEnv("STALE_ROUTER_KEY", "second-token");
    const refreshed = expectConnection(await load(dir));
    expect(refreshed.baseUrl).toBe("http://localhost:20129/v2");
    expect(refreshed.resolvedApiKey).toBe("second-token");
  });

  test("isolates two agent directories", async () => {
    const first = await makeAgentDir();
    const second = await makeAgentDir();
    await writeModels(
      first,
      providerConfig({
        baseUrl: "http://localhost:20128/v1",
        apiKey: "first-token",
      }),
    );
    await writeModels(
      second,
      providerConfig({
        baseUrl: "http://localhost:20129/v1",
        apiKey: "second-token",
      }),
    );

    expect(expectConnection(await load(first)).apiKeyConfig).toBe(
      "first-token",
    );
    expect(expectConnection(await load(second)).apiKeyConfig).toBe(
      "second-token",
    );
  });

  test("uses the active native agent directory by default", async () => {
    const dir = await makeAgentDir();
    await writeModels(
      dir,
      providerConfig({ baseUrl: "http://localhost:20130/v1" }),
    );
    const script = `
const { readNineRouterConnection } = await import(${JSON.stringify(CONFIG_IMPORT_URL)});
const result = await readNineRouterConnection();
console.log(JSON.stringify(result.ok
  ? { ok: true, baseUrl: result.connection.baseUrl }
  : { ok: false, code: result.error.code, message: result.error.message }));
`;
    const env: Record<string, string | undefined> = {
      ...process.env,
      PI_CODING_AGENT_DIR: dir,
    };
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
    const child = Bun.spawn(["bun", "-e", script], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (exitCode !== 0) throw new Error(`child exited ${exitCode}: ${stderr}`);
    const payload = JSON.parse(stdout.trim().split("\n").pop() ?? "null");
    expect(payload).toEqual({ ok: true, baseUrl: "http://localhost:20130/v1" });
  });
});

describe("9router invalid configuration", () => {
  test("invalid: a missing models.yml is reported without creating files", async () => {
    const dir = await makeAgentDir();
    const error = expectFailure(await load(dir));
    expect(error.code).toBe("config-missing");
    expect(await readdir(dir)).toEqual([]);
  });

  test("invalid: malformed YAML is rejected with a redacted diagnostic and untouched bytes", async () => {
    const dir = await makeAgentDir();
    const path = await writeModels(dir, "providers: [\n9router: !secret\n");
    const before = await readFile(path);

    const error = expectFailure(await load(dir));

    expect(error.code).toBe("config-invalid-yaml");
    expect(
      `${error.message} ${error.name} ${JSON.stringify(error)}`,
    ).not.toContain("!secret");
    expect(await readFile(path)).toEqual(before);
  });

  test("invalid: a config over 1 MiB is rejected before parsing", async () => {
    const dir = await makeAgentDir();
    await writeModels(
      dir,
      `providers:\n  9router: {}\n#${"x".repeat(MAX_BYTES)}\n`,
    );

    expect(expectFailure(await load(dir)).code).toBe("config-too-large");
  });

  test("invalid: empty or non-string api keys are rejected without echoing config", async () => {
    for (const apiKey of ["", "   ", 42, null]) {
      const dir = await makeAgentDir();
      await writeModels(dir, providerConfig({ apiKey }));
      const error = expectFailure(await load(dir));
      expect(error.code).toBe("invalid-api-key");
      expect(error.message).not.toContain("sk-test-token");
    }
  });

  test("invalid: command-backed api keys are rejected and never executed", async () => {
    const dir = await makeAgentDir();
    const marker = join(dir, "command-executed");
    await writeModels(dir, providerConfig({ apiKey: `!touch ${marker}` }));

    const error = expectFailure(await load(dir));

    expect(error.code).toBe("command-api-key");
    expect(error.message).not.toContain("touch");
    expect(await readdir(dir)).toEqual(["models.yml"]);
  });

  test("invalid: base URLs with credentials, query, fragment, relative paths, or bad schemes are rejected", async () => {
    for (const baseUrl of [
      "/relative",
      "ftp://router.example.com/v1",
      "http://user:pass@router.example.com/v1",
      "http://router.example.com/v1?token=secret",
      "http://router.example.com/v1#fragment",
      "http:///v1",
    ]) {
      const dir = await makeAgentDir();
      await writeModels(dir, providerConfig({ baseUrl }));
      expect(expectFailure(await load(dir)).code).toBe("invalid-base-url");
    }
  });

  test("invalid: unsupported api values are rejected", async () => {
    for (const api of ["anthropic-messages", 7]) {
      const dir = await makeAgentDir();
      await writeModels(dir, providerConfig({ api }));
      expect(expectFailure(await load(dir)).code).toBe("invalid-api");
    }
  });

  test("invalid: manual roster, discovery, overrides, auth, and headers are conflicts", async () => {
    const conflicts: Record<string, unknown>[] = [
      { models: [{ id: "manual-model", api: "openai-completions" }] },
      { discovery: { type: "proxy" } },
      { modelOverrides: { "manual-model": { api: "openai-completions" } } },
      { auth: "none" },
      { oauth: { provider: "router" } },
      { oauthConfigured: true },
      { headers: { Authorization: "Bearer secret" } },
    ];
    for (const conflict of conflicts) {
      const dir = await makeAgentDir();
      await writeModels(dir, providerConfig(conflict));
      const error = expectFailure(await load(dir));
      expect(error.code).toBe("unsupported-provider-key");
      expect(error.message).not.toContain("manual-model");
      expect(error.message).not.toContain("Bearer secret");
    }
  });

  test("invalid: missing or malformed provider entries are rejected", async () => {
    for (const contents of [
      "providers: {}\n",
      "providers: []\n",
      "providers:\n  9router: nope\n",
      "providers:\n  9router: [1]\n",
      "[]\n",
    ]) {
      const dir = await makeAgentDir();
      await writeModels(dir, contents);
      const error = expectFailure(await load(dir));
      expect([
        "provider-missing",
        "provider-invalid",
        "config-invalid-shape",
      ]).toContain(error.code);
    }
  });

  test("invalid: secret sentinels never reach diagnostics", async () => {
    const dir = await makeAgentDir();
    const sentinel = "sk-sentinel-do-not-leak";
    await writeModels(
      dir,
      providerConfig({
        apiKey: sentinel,
        baseUrl: "http://user:pass@router.example.com/v1",
      }),
    );

    const error = expectFailure(await load(dir));
    const rendered = `${error.message} ${error.name} ${error.code} ${JSON.stringify(error)}`;

    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain("pass");
  });

  test("invalid: no HTTP request is attempted", async () => {
    const dir = await makeAgentDir();
    await writeModels(dir, providerConfig({ baseUrl: "not-a-url" }));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("unexpected HTTP request");
    }) as unknown as typeof globalThis.fetch;
    try {
      expect(expectFailure(await load(dir)).code).toBe("invalid-base-url");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(0);
  });
});

describe("README configuration", () => {
  test("README example is accepted by the connection reader", async () => {
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/```yaml\s*\n([\s\S]*?)\n```/g)];
    expect(blocks).toHaveLength(1);
    const yaml = blocks[0]?.[1];
    if (yaml === undefined) throw new Error("README YAML example is missing");
    const dir = await makeAgentDir();
    await writeModels(dir, yaml);
    setEnv("NINE_ROUTER_API_KEY", "fixture-secret");

    expect(expectConnection(await load(dir))).toEqual({
      providerId: "9router",
      baseUrl: "http://localhost:20128/v1",
      api: "openai-completions",
      apiKeyConfig: "NINE_ROUTER_API_KEY",
      resolvedApiKey: "fixture-secret",
    });
  });

  test("README troubleshooting: missing key and manual roster produce typed diagnostics", async () => {
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
    const yaml = /```yaml\s*\n([\s\S]*?)\n```/.exec(readme)?.[1];
    if (yaml === undefined) throw new Error("README YAML example is missing");
    const missingKeyDir = await makeAgentDir();
    const rosterDir = await makeAgentDir();
    await writeModels(missingKeyDir, yaml.replace(/^\s*apiKey:.*$/m, ""));
    await writeModels(rosterDir, `${yaml}\n    models: []\n`);

    expect(expectFailure(await load(missingKeyDir)).code).toBe(
      "invalid-api-key",
    );
    expect(expectFailure(await load(rosterDir)).code).toBe(
      "unsupported-provider-key",
    );
  });
});
