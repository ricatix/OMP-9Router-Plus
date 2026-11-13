// allow: SIZE_OK - task 8 pins one loopback router fixture shared by the
// integration test and the manual runtime smoke script.
/**
 * Loopback-only fake 9Router used by the runtime proof.
 *
 * It serves the discovery endpoint, a valid OpenAI-compatible SSE completion,
 * and a separate `other` provider path used to prove OMP stays usable when
 * 9Router discovery fails. Every request is recorded with the exact bearer so
 * the caller can assert discovery versus completion credentials separately.
 *
 * No request ever leaves the loopback interface: the listener is bound to
 * 127.0.0.1, and the test harness rejects non-loopback fetch in the child
 * process.
 */
export interface FakeRouterCall {
  readonly kind:
    | "discovery"
    | "completion"
    | "other-discovery"
    | "other-completion";
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body?: Record<string, unknown>;
}

export type FakeRouterMode =
  | "success"
  | "unauthorized"
  | "server-error"
  | "malformed-json";

export interface FakeRouter {
  /** `http://127.0.0.1:<port>` with no path suffix. */
  readonly origin: string;
  /** 9Router connection root, ending in `/v1`. */
  readonly nineRouterBaseUrl: string;
  /** Independent provider root used as the "OMP stays usable" control. */
  readonly otherBaseUrl: string;
  readonly calls: FakeRouterCall[];
  setRoster(roster: readonly unknown[]): void;
  setMode(mode: FakeRouterMode): void;
  resetCalls(): void;
  stop(): void;
}

export interface FakeRouterOptions {
  readonly roster: readonly unknown[];
  readonly mode?: FakeRouterMode;
}

const OTHER_MODEL = {
  id: "keep-me",
  kind: "llm",
  name: "keep-me",
  capabilities: { reasoning: false, tools: false, vision: false },
};

export function startFakeRouter(options: FakeRouterOptions): FakeRouter {
  let roster = options.roster;
  let mode = options.mode ?? "success";
  const calls: FakeRouterCall[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
        return new Response("loopback only", { status: 400 });

      const authorization = request.headers.get("authorization");
      if (url.pathname.startsWith("/other/v1/")) {
        if (request.method === "GET" && url.pathname.endsWith("/models")) {
          calls.push({
            kind: "other-discovery",
            method: request.method,
            path: url.pathname,
            authorization,
          });
          return Response.json({ data: [OTHER_MODEL] });
        }
        if (
          request.method === "POST" &&
          url.pathname.endsWith("/chat/completions")
        ) {
          const body = await readJsonObject(request);
          calls.push({
            kind: "other-completion",
            method: request.method,
            path: url.pathname,
            authorization,
            body,
          });
          return sseResponse(
            typeof body.model === "string" ? body.model : "keep-me",
          );
        }
        return new Response("not found", { status: 404 });
      }

      if (request.method === "GET" && isDiscoveryPath(url.pathname)) {
        calls.push({
          kind: "discovery",
          method: request.method,
          path: url.pathname,
          authorization,
        });
        if (mode === "unauthorized")
          return new Response("unauthorized fixture", { status: 401 });
        if (mode === "server-error")
          return new Response("fixture failure", { status: 503 });
        if (mode === "malformed-json")
          return new Response('{"data": [', {
            headers: { "content-type": "application/json" },
          });
        return Response.json({ data: roster });
      }

      if (
        request.method === "POST" &&
        url.pathname.endsWith("/chat/completions")
      ) {
        const body = await readJsonObject(request);
        calls.push({
          kind: "completion",
          method: request.method,
          path: url.pathname,
          authorization,
          body,
        });
        if (mode === "unauthorized")
          return new Response("unauthorized fixture", { status: 401 });
        if (mode === "server-error")
          return new Response("fixture failure", { status: 503 });
        return sseResponse(
          typeof body.model === "string" ? body.model : "model",
        );
      }

      return new Response("not found", { status: 404 });
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    nineRouterBaseUrl: `${origin}/v1`,
    otherBaseUrl: `${origin}/other/v1`,
    calls,
    setRoster(next) {
      roster = next;
    },
    setMode(next) {
      mode = next;
    },
    resetCalls() {
      calls.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}

function isDiscoveryPath(pathname: string): boolean {
  return (
    pathname === "/v1" ||
    pathname === "/v1/" ||
    pathname === "/v1/models" ||
    pathname === "/v1/model"
  );
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sseResponse(model: string): Response {
  const chunks = [
    {
      id: "chatcmpl-task8",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "OK" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-task8",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
