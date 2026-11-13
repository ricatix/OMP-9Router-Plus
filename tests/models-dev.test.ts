// allow: SIZE_OK - task 5 mandates one models.dev cache and lookup matrix file.
/**
 * models.dev enrichment tests. Every request is injected through a stub
 * `fetch`; no public metadata endpoint is ever contacted. Each cache lives in
 * a task-owned temporary directory, never the user's home cache.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelsDevClient,
  MODELS_DEV_CACHE_DIR,
  MODELS_DEV_REQUEST_TIMEOUT_MS,
  type ModelsDevClient,
} from "../src/models-dev.js";

const API_URL = "https://metadata.test/api.json";
const MODELS_URL = "https://metadata.test/models.json";
const API_FILE = "models.dev.api.json";
const MODELS_FILE = "models.dev.models.json";
const TTL_MS = 24 * 60 * 60 * 1000;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const tempDirs: string[] = [];

async function tempDir(prefix = "omp-9router-models-dev-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function clientFor(cacheDir: string, fetchImpl: FetchLike): ModelsDevClient {
  return createModelsDevClient({
    cacheDir,
    fetch: fetchImpl,
    apiUrl: API_URL,
    modelsUrl: MODELS_URL,
  });
}

async function writeEnvelope(
  file: string,
  data: unknown,
  timestamp = Date.now(),
): Promise<void> {
  await writeFile(file, JSON.stringify({ timestamp, data }), "utf8");
}

async function readEnvelope(
  file: string,
): Promise<{ timestamp: unknown; data: unknown }> {
  return JSON.parse(await readFile(file, "utf8")) as {
    timestamp: unknown;
    data: unknown;
  };
}

async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("bounded wait expired")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("cache and lookup", () => {
  test("memoizes catalogs and resolves canonical, exact, full-id, and unique leaf references", async () => {
    const dir = await tempDir();
    const calls: string[] = [];
    const client = clientFor(dir, async (input) => {
      const url = String(input);
      calls.push(url);
      return url === API_URL
        ? jsonResponse({
            p: {
              id: "p",
              name: "P",
              models: {
                m: { id: "m", name: "provider" },
                "p/full": { id: "p/full", name: "fallback" },
              },
            },
          })
        : jsonResponse({
            "p/m": { id: "p/m", name: "global" },
            "private/exact": { id: "private/exact", name: "exact" },
            "openai/gpt-5.6": { id: "openai/gpt-5.6", name: "leaf" },
          });
    });

    expect(await client.lookupCanonical("p", "p/m")).toMatchObject({
      providerModel: { name: "provider" },
      modelOnly: { name: "global" },
    });
    expect(await client.lookupCanonical("p", "p/m")).toBeDefined();
    expect(
      (await client.lookupCanonical("p", "p/full")).providerModel?.name,
    ).toBe("fallback");
    expect(await client.lookupExact("private/exact")).toMatchObject({
      name: "exact",
    });
    expect(await client.lookupExact("p/m")).toMatchObject({ name: "global" });
    expect(await client.lookupExact("p/absent")).toBeNull();
    expect(
      await client.lookupUniqueLeaf("private/nested/gpt-5.6"),
    ).toMatchObject({ name: "leaf" });
    expect([...calls].sort()).toEqual([API_URL, MODELS_URL].sort());
  });

  test("persists a fresh envelope and reuses it from a new client without fetching", async () => {
    const dir = await tempDir();
    let fetches = 0;
    const first = clientFor(dir, async () => {
      fetches++;
      return jsonResponse({ "p/m": { id: "p/m", name: "Cached" } });
    });

    expect((await first.lookupExact("p/m"))?.name).toBe("Cached");
    expect(fetches).toBe(1);
    expect(await readdir(dir)).toEqual([MODELS_FILE]);

    const envelope = await readEnvelope(join(dir, MODELS_FILE));
    expect(Object.keys(envelope).sort()).toEqual(["data", "timestamp"]);
    expect(typeof envelope.timestamp).toBe("number");
    expect(envelope.data).toEqual({ "p/m": { id: "p/m", name: "Cached" } });
    expect(JSON.stringify(envelope)).not.toContain(API_URL);
    expect(JSON.stringify(envelope)).not.toContain(MODELS_URL);

    let secondFetches = 0;
    const second = clientFor(dir, async () => {
      secondFetches++;
      return jsonResponse({});
    });
    expect((await second.lookupExact("p/m"))?.name).toBe("Cached");
    expect(secondFetches).toBe(0);
  });

  test("refreshes expired cache while treating a fresh valid empty cache as a hit", async () => {
    const staleDir = await tempDir();
    await writeEnvelope(
      join(staleDir, MODELS_FILE),
      { "p/m": { id: "p/m", name: "stale" } },
      Date.now() - TTL_MS - 1,
    );
    let staleFetches = 0;
    const stale = clientFor(staleDir, async () => {
      staleFetches++;
      return jsonResponse({ "p/m": { id: "p/m", name: "fresh" } });
    });

    expect((await stale.lookupExact("p/m"))?.name).toBe("fresh");
    expect(staleFetches).toBe(1);
    const refreshed = await readEnvelope(join(staleDir, MODELS_FILE));
    expect(typeof refreshed.timestamp).toBe("number");
    expect(Date.now() - (refreshed.timestamp as number)).toBeLessThan(5000);

    const emptyDir = await tempDir();
    await writeEnvelope(join(emptyDir, MODELS_FILE), {});
    let emptyFetches = 0;
    const empty = clientFor(emptyDir, async () => {
      emptyFetches++;
      return jsonResponse({ "p/m": { id: "p/m", name: "unexpected" } });
    });
    expect(await empty.lookupExact("p/m")).toBeNull();
    expect(emptyFetches).toBe(0);
  });

  test("writes atomically with no leftover temporary files", async () => {
    const dir = await tempDir();
    const client = clientFor(dir, async () =>
      jsonResponse({ "p/m": { id: "p/m", name: "atomic" } }),
    );

    expect((await client.lookupExact("p/m"))?.name).toBe("atomic");
    const files = await readdir(dir);
    expect(files).toEqual([MODELS_FILE]);
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("starts independent metadata requests in parallel", async () => {
    const dir = await tempDir();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const client = clientFor(dir, async (input) => {
      const url = String(input);
      started.push(url);
      if (started.length === 2) bothStarted();
      await gate;
      return url === API_URL
        ? jsonResponse({
            p: { models: { m: { id: "m", name: "parallel" } } },
          })
        : jsonResponse({ "p/m": { id: "p/m", name: "parallel" } });
    });

    const lookup = client.lookupCanonical("p", "p/m");
    await within(ready);
    expect(started.sort()).toEqual([API_URL, MODELS_URL].sort());
    release();

    expect(await lookup).toMatchObject({
      providerModel: { name: "parallel" },
      modelOnly: { name: "parallel" },
    });
  });

  test("uses a 5 MiB API cache cap and a 1 MiB models cache cap", async () => {
    const apiName = "a".repeat(1_500_000);
    const apiDir = await tempDir();
    await writeEnvelope(join(apiDir, API_FILE), {
      p: { models: { m: { id: "m", name: apiName } } },
    });
    const apiCalls: string[] = [];
    const apiClient = clientFor(apiDir, async (input) => {
      apiCalls.push(String(input));
      return jsonResponse({});
    });
    const canonical = await apiClient.lookupCanonical("p", "p/m");
    expect(canonical.providerModel?.name).toBe(apiName);
    expect(canonical.modelOnly).toBeNull();
    expect(apiCalls).toEqual([MODELS_URL]);

    const modelName = "b".repeat(1_500_000);
    const modelsDir = await tempDir();
    await writeEnvelope(join(modelsDir, MODELS_FILE), {
      "p/m": { id: "p/m", name: modelName },
    });
    const modelCalls: string[] = [];
    const modelsClient = clientFor(modelsDir, async (input) => {
      modelCalls.push(String(input));
      return jsonResponse({ "p/m": { id: "p/m", name: "fetched" } });
    });
    expect((await modelsClient.lookupExact("p/m"))?.name).toBe("fetched");
    expect(modelCalls).toEqual([MODELS_URL]);
  });

  test("bounds every request at 15 seconds and passes an abort signal", async () => {
    expect(MODELS_DEV_REQUEST_TIMEOUT_MS).toBe(15_000);
    const dir = await tempDir();
    const signals: Array<AbortSignal | null | undefined> = [];
    const client = clientFor(dir, async (_input, init) => {
      signals.push(init?.signal);
      throw new Error("offline");
    });

    expect(await client.lookupExact("p/m")).toBeNull();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  test("uses the omp-9router-plus cache namespace and documented filenames", async () => {
    expect(MODELS_DEV_CACHE_DIR).toBe(
      join(homedir(), ".cache", "omp-9router-plus"),
    );
    const dir = await tempDir();
    const client = clientFor(dir, async () =>
      jsonResponse({ "p/m": { id: "p/m", name: "namespace" } }),
    );

    expect((await client.lookupExact("p/m"))?.name).toBe("namespace");
    expect(await readdir(dir)).toEqual([MODELS_FILE]);
  });

  test("does not write fetched metadata above the cache cap", async () => {
    const dir = await tempDir();
    const emptyBody = JSON.stringify({ "p/m": { id: "p/m", name: "" } });
    const name = "z".repeat(1_048_575 - Buffer.byteLength(emptyBody));
    const client = clientFor(dir, async () =>
      jsonResponse({ "p/m": { id: "p/m", name } }),
    );

    expect((await client.lookupExact("p/m"))?.name).toBe(name);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("boundary", () => {
  test("keeps corrupt cache and failed metadata fetch nonfatal", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, MODELS_FILE), "{");
    const offline = clientFor(dir, async () => {
      throw new Error("offline");
    });

    expect(await offline.lookupExact("p/m")).toBeNull();
    expect(await offline.lookupUniqueLeaf("x/m")).toBeNull();
    expect(await offline.lookupCanonical("p", "p/m")).toEqual({
      providerModel: null,
      modelOnly: null,
    });
    expect(await readdir(dir)).toEqual([MODELS_FILE]);

    let fetches = 0;
    const recovered = clientFor(dir, async () => {
      fetches++;
      return jsonResponse({ "p/m": { id: "p/m", name: "recovered" } });
    });
    expect((await recovered.lookupExact("p/m"))?.name).toBe("recovered");
    expect(fetches).toBe(1);
  });

  test("rejects catalogs above provider, provider-model, and global limits", async () => {
    const dir = await tempDir();
    const tooManyProviders = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`p${index}`, { models: {} }]),
    );
    const tooManyProviderModels = {
      p: {
        models: Object.fromEntries(
          Array.from({ length: 5001 }, (_, index) => [
            `m${index}`,
            { id: "x", name: "x" },
          ]),
        ),
      },
    };
    const tooManyModels = Object.fromEntries(
      Array.from({ length: 20_001 }, (_, index) => [
        `p/m${index}`,
        { id: "x", name: "x" },
      ]),
    );
    const cases: Array<{ api: unknown; models: unknown; canonical: boolean }> =
      [
        { api: tooManyProviders, models: {}, canonical: true },
        { api: tooManyProviderModels, models: {}, canonical: true },
        { api: {}, models: tooManyModels, canonical: false },
      ];

    for (const item of cases) {
      const client = clientFor(dir, async (input) =>
        jsonResponse(String(input) === API_URL ? item.api : item.models),
      );
      const result = item.canonical
        ? await client.lookupCanonical("p", "p/m")
        : await client.lookupExact("p/m0");
      expect(result).toEqual(
        item.canonical ? { providerModel: null, modelOnly: null } : null,
      );
    }
    expect(await readdir(dir)).toEqual([]);
  });

  test("rejects unsafe ids and records with too many own fields", async () => {
    const dir = await tempDir();
    const longId = "x".repeat(513);
    const manyKeys = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key${index}`, index]),
    );
    for (const payload of [
      { [longId]: { id: longId, name: "long" } },
      { "bad\nid": { id: "bad\nid", name: "control" } },
      { "p/m": manyKeys },
    ]) {
      const client = clientFor(dir, async () => jsonResponse(payload));
      expect(await client.lookupExact("p/m")).toBeNull();
    }
    expect(await readdir(dir)).toEqual([]);

    const apiClient = clientFor(dir, async (input) =>
      jsonResponse(
        String(input) === API_URL
          ? { "bad\u0001": { models: {} } }
          : { "p/m": { id: "p/m", name: "models-only" } },
      ),
    );
    const canonical = await apiClient.lookupCanonical("p", "p/m");
    expect(canonical.providerModel).toBeNull();
    expect(canonical.modelOnly).toMatchObject({ name: "models-only" });
    expect(await readdir(dir)).toEqual([MODELS_FILE]);
  });

  test("rejects oversized cache files before parsing", async () => {
    const dir = await tempDir();
    const marker = "OVERSIZE_CACHE_SENTINEL";
    await writeFile(
      join(dir, MODELS_FILE),
      `${JSON.stringify({ timestamp: Date.now(), data: { marker } })}${" ".repeat(1_048_576)}`,
      "utf8",
    );

    const original = JSON.parse;
    let sawMarker = false;
    JSON.parse = ((value: string) => {
      if (value.includes(marker)) sawMarker = true;
      return original(value);
    }) as typeof JSON.parse;
    try {
      let fetches = 0;
      const client = clientFor(dir, async () => {
        fetches++;
        return jsonResponse({ "p/m": { id: "p/m", name: "fetched" } });
      });
      expect((await client.lookupExact("p/m"))?.name).toBe("fetched");
      expect(fetches).toBe(1);
      expect(sawMarker).toBe(false);
    } finally {
      JSON.parse = original;
    }
  });

  test("rejects API cache above 5 MiB and falls back to fetch", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, API_FILE),
      `${JSON.stringify({
        timestamp: Date.now(),
        data: { p: { models: { m: { id: "m", name: "cached" } } } },
      })}${" ".repeat(5 * 1_048_576)}`,
      "utf8",
    );
    let fetches = 0;
    const client = clientFor(dir, async (input) => {
      fetches++;
      return jsonResponse(
        String(input) === API_URL
          ? { p: { models: { m: { id: "m", name: "fetched" } } } }
          : {},
      );
    });

    expect((await client.lookupCanonical("p", "p/m")).providerModel?.name).toBe(
      "fetched",
    );
    expect(fetches).toBe(2);
  });

  test("keeps unwritable cache and network failures nonfatal and removes temporary files", async () => {
    const blockerDir = await tempDir();
    const blocker = join(blockerDir, "blocker");
    await writeFile(blocker, "not a directory");
    const blocked = clientFor(blocker, async () =>
      jsonResponse({ "p/m": { id: "p/m", name: "blocked" } }),
    );
    expect((await blocked.lookupExact("p/m"))?.name).toBe("blocked");
    expect(await readFile(blocker, "utf8")).toBe("not a directory");

    const renameDir = await tempDir();
    await mkdir(join(renameDir, MODELS_FILE));
    const failing = clientFor(renameDir, async () =>
      jsonResponse({ "p/m": { id: "p/m", name: "rename" } }),
    );
    expect((await failing.lookupExact("p/m"))?.name).toBe("rename");
    const files = await readdir(renameDir);
    expect(files).toEqual([MODELS_FILE]);
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);

    const offlineDir = await tempDir();
    const offline = clientFor(offlineDir, async () => {
      throw new Error("offline");
    });
    expect(await offline.lookupExact("p/m")).toBeNull();
    expect(await readdir(offlineDir)).toEqual([]);
  });

  test("returns no enrichment for ambiguous, absent, and case-mismatched leaves", async () => {
    const dir = await tempDir();
    const client = clientFor(dir, async () =>
      jsonResponse({
        "a/gpt-5.6": { id: "a/gpt-5.6", name: "one" },
        "b/gpt-5.6": { id: "b/gpt-5.6", name: "two" },
        "c/GPT-5.7": { id: "c/GPT-5.7", name: "case" },
      }),
    );

    expect(await client.lookupUniqueLeaf("private/gpt-5.6")).toBeNull();
    expect(await client.lookupUniqueLeaf("private/gpt-5.7")).toBeNull();
    expect(await client.lookupUniqueLeaf("private/missing")).toBeNull();
    expect((await client.lookupExact("c/GPT-5.7"))?.name).toBe("case");
    expect(
      (await client.lookupUniqueLeaf("private/nested/GPT-5.7"))?.name,
    ).toBe("case");
  });

  test("rejects metadata response bodies above their catalog caps", async () => {
    const dir = await tempDir();
    const apiBody = " ".repeat(5 * 1_048_576 + 1);
    const apiClient = clientFor(
      dir,
      async (input) => new Response(String(input) === API_URL ? apiBody : "{}"),
    );
    expect(await apiClient.lookupCanonical("p", "p/m")).toEqual({
      providerModel: null,
      modelOnly: null,
    });
    expect(await readdir(dir)).toEqual([]);

    const modelsBody = " ".repeat(1_048_576 + 1);
    const modelsClient = clientFor(dir, async () => new Response(modelsBody));
    expect(await modelsClient.lookupExact("p/m")).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  test("treats non-OK, malformed JSON, and empty bodies as empty metadata", async () => {
    const dir = await tempDir();
    for (const make of [
      () => new Response("nope", { status: 500 }),
      () => new Response("not-json", { status: 200 }),
      () => new Response(null, { status: 200 }),
    ]) {
      const client = clientFor(dir, async () => make());
      expect(await client.lookupExact("p/m")).toBeNull();
    }
    expect(await readdir(dir)).toEqual([]);
  });
});
