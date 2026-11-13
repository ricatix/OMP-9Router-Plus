// allow: SIZE_OK - task 3 mandates one discovery parser and HTTP boundary matrix file.
import { afterEach, describe, expect, test } from "bun:test";
import { acceptDiscoveryEntries, discoverModels } from "../src/discovery.js";

type StopableServer = { stop(force?: boolean): void };

const servers: StopableServer[] = [];
const ORIGIN = (base: string) => new URL(base).origin;
const PATH = (request: Request) => new URL(request.url).pathname;
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

function serve(
  handler: (request: Request) => Response | Promise<Response>,
): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
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

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("live discovery over loopback", () => {
  test("follows base/models, base/model, then base in order", async () => {
    const paths: string[] = [];
    const base = serve((request) => {
      const path = PATH(request);
      paths.push(path);
      return path === "/v1"
        ? json([{ id: "base/model", kind: "llm" }])
        : json({ data: [] });
    });

    const result = await discoverModels({
      baseUrl: `${base}/v1/`,
      apiKey: "live-token",
    });

    expect(result).toEqual({
      ok: true,
      entries: [{ id: "base/model", kind: "llm", live: {} }],
    });
    expect(paths).toEqual(["/v1/models", "/v1/model", "/v1"]);
  });

  test("accepts root, models, and data arrays without filtering kind or rewriting ids", async () => {
    let payload: unknown = [];
    const base = serve(() => json(payload));
    const cases: Array<{ body: unknown; id: string }> = [
      { body: [{ id: "cx/test-model", kind: "image" }], id: "cx/test-model" },
      { body: { models: [{ id: "cmc/test-model" }] }, id: "cmc/test-model" },
      {
        body: { data: [{ id: "private/model", kind: "tts" }] },
        id: "private/model",
      },
    ];

    for (const item of cases) {
      payload = item.body;
      const result = await discoverModels({
        baseUrl: base,
        apiKey: "live-token",
      });
      expect(result).toEqual({
        ok: true,
        entries: [{ id: item.id, kind: "llm", live: {} }],
      });
    }
  });

  test("preserves false, string booleans, names, and limit fields", async () => {
    const base = serve(() =>
      json({
        data: [
          {
            id: "cx/reasoner",
            name: "Reasoner",
            capabilities: {
              reasoning: "false",
              tools: false,
              vision: "true",
              pdf: "false",
              contextWindow: "128000",
              maxOutput: 8192,
              thinkingFormat: "commandcode",
              thinkingCanDisable: "true",
              thinkingRange: { values: ["low", "high"] },
              thinkingEffortSupported: false,
            },
            context_length: 200000,
            max_completion_tokens: "16384",
            thinking_levels: ["low", "high"],
          },
        ],
      }),
    );

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "live-token",
    });

    expect(result).toEqual({
      ok: true,
      entries: [
        {
          id: "cx/reasoner",
          kind: "llm",
          live: {
            name: "Reasoner",
            capabilities: {
              reasoning: false,
              tools: false,
              vision: true,
              pdf: false,
              contextWindow: 128000,
              maxOutput: 8192,
              thinkingFormat: "commandcode",
              thinkingCanDisable: true,
              thinkingRange: { values: ["low", "high"] },
              thinkingEffortSupported: false,
            },
            context_length: 200000,
            max_completion_tokens: 16384,
            thinking_levels: ["low", "high"],
          },
        },
      ],
    });
  });

  test("keeps the first duplicate and rejects unsafe ids", async () => {
    const base = serve(() =>
      json({
        models: [
          { id: "dup", name: "first" },
          { id: "dup", name: "second" },
          { id: "__proto__", name: "danger" },
          { id: "constructor" },
          { id: " x" },
          { id: "x\n" },
          { id: "x".repeat(513) },
          { id: "ok/image", kind: "image" },
        ],
      }),
    );

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "live-token",
    });

    expect(result).toEqual({
      ok: true,
      entries: [
        { id: "dup", kind: "llm", live: { name: "first" } },
        { id: "ok/image", kind: "llm", live: {} },
      ],
    });
  });

  test("falls back after a failed endpoint without retrying the same path", async () => {
    const paths: string[] = [];
    const base = serve((request) => {
      const path = PATH(request);
      paths.push(path);
      if (path === "/models") return new Response("boom", { status: 500 });
      return json({ data: [{ id: "fallback/model" }] });
    });

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "live-token",
    });

    expect(result).toEqual({
      ok: true,
      entries: [{ id: "fallback/model", kind: "llm", live: {} }],
    });
    expect(paths).toEqual(["/models", "/model"]);
  });

  test("sends bearer on every same-origin request and stays fresh between invocations", async () => {
    let roster = ["first/model"];
    const paths: string[] = [];
    const authorization: Array<string | null> = [];
    const base = serve((request) => {
      paths.push(PATH(request));
      authorization.push(request.headers.get("authorization"));
      return json({ models: roster.map((id) => ({ id })) });
    });

    const first = await discoverModels({ baseUrl: base, apiKey: "live-token" });
    roster = ["second/model"];
    const second = await discoverModels({
      baseUrl: base,
      apiKey: "live-token",
    });

    expect(first).toEqual({
      ok: true,
      entries: [{ id: "first/model", kind: "llm", live: {} }],
    });
    expect(second).toEqual({
      ok: true,
      entries: [{ id: "second/model", kind: "llm", live: {} }],
    });
    expect(paths).toEqual(["/models", "/models"]);
    expect(authorization).toEqual(["Bearer live-token", "Bearer live-token"]);
  });
});

describe("discovery boundary", () => {
  test("rejects cross-origin redirects without forwarding the bearer", async () => {
    let targetHits = 0;
    const observed: { authorization: string | null } = { authorization: null };
    const target = serve((request) => {
      targetHits++;
      observed.authorization = request.headers.get("authorization");
      return json({ data: [{ id: "stolen" }] });
    });
    const origin = serve((request) =>
      PATH(request) === "/models"
        ? new Response(null, {
            status: 302,
            headers: { location: `${target}/models` },
          })
        : new Response("missing", { status: 404 }),
    );

    const result = await discoverModels({
      baseUrl: origin,
      apiKey: "boundary-token",
    });

    expect(result).toEqual({
      ok: false,
      category: "cross-origin-redirect",
      status: 302,
      host: ORIGIN(origin),
    });
    expect(targetHits).toBe(0);
    expect(observed.authorization).toBeNull();
    expect(JSON.stringify(result)).not.toContain("boundary-token");
  });

  test("times out every endpoint and cancels each stalled request", async () => {
    let aborted = 0;
    let resolveAll!: () => void;
    const allAborted = new Promise<void>((resolve) => {
      resolveAll = resolve;
    });
    const base = serve((request) => {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted++;
          if (aborted === 3) resolveAll();
        },
        { once: true },
      );
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => resolve(new Response(null, { status: 499 })),
          { once: true },
        );
      });
    });

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "boundary-token",
      timeoutMs: 40,
    });

    expect(result).toEqual({
      ok: false,
      category: "timeout",
      host: ORIGIN(base),
    });
    await within(allAborted);
    expect(aborted).toBe(3);
  });

  test("maps 401 to unauthorized without leaking bearer or response body", async () => {
    const observed: { authorization: string | null } = { authorization: null };
    const base = serve((request) => {
      observed.authorization = request.headers.get("authorization");
      return new Response("secret-response-body", { status: 401 });
    });

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "boundary-token",
    });

    expect(result).toEqual({
      ok: false,
      category: "unauthorized",
      status: 401,
      host: ORIGIN(base),
    });
    expect(observed.authorization).toBe("Bearer boundary-token");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("boundary-token");
    expect(serialized).not.toContain("secret-response-body");
    expect(serialized).not.toContain("authorization");
  });

  test("cancels streaming responses above 5 MiB", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let resolveCancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    let cancelledObserved = false;
    const base = serve((request) => {
      if (PATH(request) !== "/models") {
        return new Response("missing", { status: 404 });
      }
      request.signal.addEventListener(
        "abort",
        () => {
          cancelledObserved = true;
          resolveCancel();
        },
        { once: true },
      );
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent <= 20) {
            sent++;
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
        cancel() {
          cancelledObserved = true;
          resolveCancel();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/json" },
      });
    });

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "boundary-token",
    });

    expect(result).toEqual({
      ok: false,
      category: "too-large",
      host: ORIGIN(base),
    });
    await within(cancelled);
    expect(cancelledObserved).toBe(true);
  });

  test("rejects malformed JSON from every endpoint", async () => {
    const base = serve(
      () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "boundary-token",
    });

    expect(result).toEqual({
      ok: false,
      category: "malformed-json",
      host: ORIGIN(base),
    });
  });

  test("returns typed empty and invalid responses after all endpoints fail", async () => {
    let payload: unknown = { data: [] };
    const base = serve(() => json(payload));

    const empty = await discoverModels({
      baseUrl: base,
      apiKey: "boundary-token",
    });
    expect(empty).toEqual({
      ok: false,
      category: "empty",
      host: ORIGIN(base),
    });

    payload = "scalar";
    const invalid = await discoverModels({
      baseUrl: base,
      apiKey: "boundary-token",
    });
    expect(invalid).toEqual({
      ok: false,
      category: "invalid-response",
      host: ORIGIN(base),
    });
  });

  test("bounds accepted records at 2000 and rejects oversized arrays", () => {
    const accepted = acceptDiscoveryEntries({
      data: Array.from({ length: 2000 }, (_, index) => ({ id: `m${index}` })),
    });
    expect(accepted).toHaveLength(2000);

    const rejected = acceptDiscoveryEntries({
      data: Array.from({ length: 2001 }, (_, index) => ({ id: `m${index}` })),
    });
    expect(rejected).toEqual([]);
  });

  test("drops metadata above 32 keys while keeping the id", () => {
    const record: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key${index}`, index]),
    );
    record.id = "kept";
    const capabilities = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key${index}`, index]),
    );

    const entries = acceptDiscoveryEntries({
      models: [
        record,
        {
          id: "capabilities",
          name: "Dropped",
          capabilities,
          context_length: 100,
          max_completion_tokens: 10,
        },
      ],
    });

    expect(entries).toEqual([
      { id: "kept", kind: "llm", live: {} },
      { id: "capabilities", kind: "llm", live: {} },
    ]);
  });

  test("rejects out-of-bounds thinking metadata without losing valid fields", () => {
    const entries = acceptDiscoveryEntries({
      data: [
        {
          id: "invalid-bounds",
          name: "Kept",
          capabilities: {
            reasoning: true,
            tools: "true",
            thinkingFormat: "x".repeat(65),
            thinkingCanDisable: "maybe",
            thinkingEffortSupported: 1,
            thinkingRange: Array.from(
              { length: 17 },
              (_, index) => `l${index}`,
            ),
          },
        },
        {
          id: "invalid-budget",
          capabilities: {
            reasoning: true,
            thinkingRange: { min: 5, max: 1 },
          },
        },
        {
          id: "invalid-duplicates",
          capabilities: {
            reasoning: true,
            thinkingRange: { values: ["low", "low"] },
          },
        },
        {
          id: "valid-bounds",
          capabilities: {
            reasoning: true,
            thinkingFormat: "x".repeat(64),
            thinkingRange: { min: 0, max: 1_000_000 },
          },
        },
      ],
    });

    expect(entries).toEqual([
      {
        id: "invalid-bounds",
        kind: "llm",
        live: {
          name: "Kept",
          capabilities: { reasoning: true, tools: true },
        },
      },
      {
        id: "invalid-budget",
        kind: "llm",
        live: { capabilities: { reasoning: true } },
      },
      {
        id: "invalid-duplicates",
        kind: "llm",
        live: { capabilities: { reasoning: true } },
      },
      {
        id: "valid-bounds",
        kind: "llm",
        live: {
          capabilities: {
            reasoning: true,
            thinkingFormat: "x".repeat(64),
            thinkingRange: { min: 0, max: 1_000_000 },
          },
        },
      },
    ]);
  });

  test("never invokes accessors or inherited metadata and rejects dangerous ids", () => {
    let reads = 0;
    const capabilities: Record<string, unknown> = { reasoning: true };
    Object.defineProperty(capabilities, "tools", {
      enumerable: true,
      get() {
        reads++;
        return true;
      },
    });
    Object.defineProperty(capabilities, "thinkingRange", {
      enumerable: true,
      get() {
        reads++;
        return { min: 1, max: 2 };
      },
    });
    const record: Record<string, unknown> = {
      id: "kept",
      name: "Kept",
      capabilities,
    };
    Object.defineProperty(record, "limit", {
      enumerable: true,
      get() {
        reads++;
        return { context: 1 };
      },
    });
    const inherited: Record<string, unknown> = Object.create({
      capabilities: { reasoning: true },
      name: "proto",
      thinking_levels: ["high"],
    });
    inherited.id = "inherited";
    const accessorId: Record<string, unknown> = {};
    Object.defineProperty(accessorId, "id", {
      enumerable: true,
      get() {
        reads++;
        return "accessor";
      },
    });

    const entries = acceptDiscoveryEntries({
      models: [
        record,
        inherited,
        accessorId,
        { id: "__proto__" },
        { id: "prototype" },
        { id: "constructor" },
        { id: "x".repeat(513) },
        { id: " x" },
        { id: "x\t" },
      ],
    });

    expect(entries).toEqual([
      {
        id: "kept",
        kind: "llm",
        live: { name: "Kept", capabilities: { reasoning: true } },
      },
      { id: "inherited", kind: "llm", live: {} },
    ]);
    expect(reads).toBe(0);
  });

  test("rejects invalid base URLs without echoing userinfo or query", async () => {
    const result = await discoverModels({
      baseUrl: "http://user:pass@127.0.0.1:1/v1?token=leak",
      apiKey: "boundary-token",
    });

    expect(result).toEqual({ ok: false, category: "invalid-base-url" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("pass");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("boundary-token");
  });

  test("stops after the three bounded endpoints", async () => {
    const paths: string[] = [];
    const base = serve((request) => {
      paths.push(PATH(request));
      return new Response("nope", { status: 500 });
    });

    const result = await discoverModels({
      baseUrl: base,
      apiKey: "boundary-token",
    });

    expect(result).toEqual({
      ok: false,
      category: "http",
      status: 500,
      host: ORIGIN(base),
    });
    expect(paths).toEqual(["/models", "/model", "/"]);
  });
});
