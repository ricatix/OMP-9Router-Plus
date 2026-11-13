// allow: SIZE_OK - task 3 fixes one discovery parser and HTTP boundary module at src/discovery.ts.
export type DiscoveryThinkingRange =
  | readonly string[]
  | { readonly values: readonly string[] }
  | { readonly min: number; readonly max: number };

export interface DiscoveryCapabilities {
  readonly reasoning?: boolean;
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly pdf?: boolean;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly thinkingFormat?: string;
  readonly thinkingCanDisable?: boolean;
  readonly thinkingRange?: DiscoveryThinkingRange;
  readonly thinkingEffortSupported?: boolean;
}

export interface DiscoveryLiveMetadata {
  readonly name?: string;
  readonly capabilities?: DiscoveryCapabilities;
  readonly context_length?: number;
  readonly max_completion_tokens?: number;
  readonly thinking_levels?: readonly string[];
}

export interface DiscoveryEntry {
  readonly id: string;
  readonly kind: "llm";
  readonly live: DiscoveryLiveMetadata;
}

export type DiscoveryFailureCategory =
  | "invalid-base-url"
  | "unauthorized"
  | "timeout"
  | "too-large"
  | "malformed-json"
  | "cross-origin-redirect"
  | "redirect"
  | "http"
  | "network"
  | "invalid-response"
  | "empty";

export interface DiscoveryFailure {
  readonly ok: false;
  readonly category: DiscoveryFailureCategory;
  readonly status?: number;
  readonly host?: string;
}

export interface DiscoverySuccess {
  readonly ok: true;
  readonly entries: readonly DiscoveryEntry[];
}

export type DiscoveryResult = DiscoveryFailure | DiscoverySuccess;

export interface DiscoverModelsOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type EndpointOutcome =
  | { readonly kind: "entries"; readonly entries: DiscoveryEntry[] }
  | { readonly kind: "failure"; readonly failure: DiscoveryFailure };

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 2000;
const MAX_METADATA_KEYS = 32;
const MAX_ID_CHARS = 512;
const MAX_TEXT_CHARS = 512;
const MAX_THINKING_FORMAT_CHARS = 64;
const MAX_RANGE_LEVELS = 16;
const MAX_THINKING_BUDGET = 1_000_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DANGEROUS_IDS = new Set(["__proto__", "prototype", "constructor"]);
const ENDPOINT_SUFFIXES = ["/models", "/model", ""] as const;

const isRecord = (input: unknown): input is object =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const ownValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const hasControlOrPadding = (input: string): boolean =>
  input !== input.trim() ||
  [...input].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });

const isText = (input: unknown, max = MAX_TEXT_CHARS): input is string =>
  typeof input === "string" &&
  input.length > 0 &&
  input.length <= max &&
  !hasControlOrPadding(input);

const isSafeId = (input: unknown): input is string =>
  typeof input === "string" &&
  input.length > 0 &&
  input.length <= MAX_ID_CHARS &&
  !hasControlOrPadding(input) &&
  !DANGEROUS_IDS.has(input);

const normalizeBoolean = (input: unknown): boolean | undefined =>
  input === true || input === "true"
    ? true
    : input === false || input === "false"
      ? false
      : undefined;

const positiveSafeInt = (input: unknown): number | undefined => {
  const number =
    typeof input === "number"
      ? input
      : typeof input === "string" && /^[0-9]+$/.test(input)
        ? Number(input)
        : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

const budgetInteger = (input: unknown): number | undefined => {
  const number =
    typeof input === "number"
      ? input
      : typeof input === "string" && /^[0-9]+$/.test(input)
        ? Number(input)
        : Number.NaN;
  return Number.isSafeInteger(number) &&
    number >= 0 &&
    number <= MAX_THINKING_BUDGET
    ? number
    : undefined;
};

function boundedLevels(input: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_RANGE_LEVELS
  )
    return undefined;
  const levels: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const item = ownValue(input, String(index));
    if (!isText(item, MAX_THINKING_FORMAT_CHARS) || levels.includes(item))
      return undefined;
    levels.push(item);
  }
  return levels;
}

function thinkingRange(input: unknown): DiscoveryThinkingRange | undefined {
  const direct = boundedLevels(input);
  if (direct) return direct;
  if (!isRecord(input)) return undefined;
  const keyCount = Object.keys(input).length;
  const nested = boundedLevels(ownValue(input, "values"));
  if (Object.hasOwn(input, "values") && keyCount === 1 && nested)
    return { values: nested };
  const min = budgetInteger(ownValue(input, "min"));
  const max = budgetInteger(ownValue(input, "max"));
  return keyCount === 2 && min !== undefined && max !== undefined && min <= max
    ? { min, max }
    : undefined;
}

function liveMetadata(input: object): DiscoveryLiveMetadata {
  if (Object.keys(input).length > MAX_METADATA_KEYS) return {};
  const capabilitiesInput = ownValue(input, "capabilities");
  if (
    isRecord(capabilitiesInput) &&
    Object.keys(capabilitiesInput).length > MAX_METADATA_KEYS
  )
    return {};
  const live: Mutable<DiscoveryLiveMetadata> = {};
  const name = ownValue(input, "name");
  if (isText(name)) live.name = name;
  if (isRecord(capabilitiesInput)) {
    const parsed: Mutable<DiscoveryCapabilities> = {};
    for (const key of ["reasoning", "tools", "vision", "pdf"] as const) {
      const normalized = normalizeBoolean(ownValue(capabilitiesInput, key));
      if (normalized !== undefined) parsed[key] = normalized;
    }
    for (const key of ["contextWindow", "maxOutput"] as const) {
      const normalized = positiveSafeInt(ownValue(capabilitiesInput, key));
      if (normalized !== undefined) parsed[key] = normalized;
    }
    const thinkingFormat = ownValue(capabilitiesInput, "thinkingFormat");
    if (isText(thinkingFormat, MAX_THINKING_FORMAT_CHARS))
      parsed.thinkingFormat = thinkingFormat;
    for (const key of [
      "thinkingCanDisable",
      "thinkingEffortSupported",
    ] as const) {
      const normalized = normalizeBoolean(ownValue(capabilitiesInput, key));
      if (normalized !== undefined) parsed[key] = normalized;
    }
    const range = thinkingRange(ownValue(capabilitiesInput, "thinkingRange"));
    if (range !== undefined) parsed.thinkingRange = range;
    if (Object.keys(parsed).length > 0) live.capabilities = parsed;
  }
  for (const key of ["context_length", "max_completion_tokens"] as const) {
    const normalized = positiveSafeInt(ownValue(input, key));
    if (normalized !== undefined) live[key] = normalized;
  }
  const levels = boundedLevels(ownValue(input, "thinking_levels"));
  if (levels !== undefined) live.thinking_levels = levels;
  return live;
}

function payloadValues(json: unknown): unknown[] | undefined {
  if (Array.isArray(json)) return json;
  if (!isRecord(json)) return undefined;
  const models = ownValue(json, "models");
  if (Array.isArray(models)) return models;
  const data = ownValue(json, "data");
  return Array.isArray(data) ? data : undefined;
}

function parseValues(values: unknown[]): DiscoveryEntry[] {
  const entries: DiscoveryEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const item = ownValue(values, String(index));
    if (!isRecord(item) || !Object.hasOwn(item, "id")) continue;
    const id = ownValue(item, "id");
    if (!isSafeId(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, kind: "llm", live: liveMetadata(item) });
  }
  return entries;
}

function parsePayload(json: unknown): {
  readonly entries: DiscoveryEntry[];
  readonly invalid: boolean;
} {
  const values = payloadValues(json);
  if (!values || values.length > MAX_RECORDS)
    return { entries: [], invalid: true };
  return { entries: parseValues(values), invalid: false };
}

export function acceptDiscoveryEntries(json: unknown): DiscoveryEntry[] {
  return parsePayload(json).entries;
}

const fail = (
  category: DiscoveryFailureCategory,
  host?: string,
  status?: number,
): EndpointOutcome => {
  const failure: Mutable<DiscoveryFailure> = { ok: false, category };
  if (host !== undefined) failure.host = host;
  if (status !== undefined) failure.status = status;
  return { kind: "failure", failure };
};

async function discard(response: Response): Promise<void> {
  const body = response.body;
  if (body) await body.cancel().catch(() => undefined);
}

async function readBoundedBody(
  response: Response,
): Promise<Uint8Array | "too-large"> {
  const body = response.body;
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return "too-large";
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    return DEFAULT_TIMEOUT_MS;
  return Math.min(timeoutMs, DEFAULT_TIMEOUT_MS);
}

function parseBase(
  baseUrl: string,
): { readonly href: string; readonly origin: string } | undefined {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname || url.username || url.password || url.search || url.hash)
    return undefined;
  return { href: url.href, origin: url.origin };
}

async function fetchEndpoint(
  url: URL,
  apiKey: string,
  origin: string,
  timeoutMs: number,
): Promise<EndpointOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.origin !== origin)
        return fail("cross-origin-redirect", origin);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(current, {
        signal: controller.signal,
        redirect: "manual",
        headers,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await discard(response);
        const location = response.headers.get("location");
        if (!location) return fail("redirect", origin, response.status);
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return fail("redirect", origin, response.status);
        }
        if (next.origin !== origin)
          return fail("cross-origin-redirect", origin, response.status);
        if (next.username || next.password)
          return fail("redirect", origin, response.status);
        current = next;
        continue;
      }
      if (!response.ok) {
        await discard(response);
        return fail(
          response.status === 401 ? "unauthorized" : "http",
          origin,
          response.status,
        );
      }
      const bytes = await readBoundedBody(response);
      if (bytes === "too-large") return fail("too-large", origin);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return fail("malformed-json", origin);
      }
      const parsed = parsePayload(json);
      if (parsed.invalid) return fail("invalid-response", origin);
      return { kind: "entries", entries: parsed.entries };
    }
    return fail("redirect", origin);
  } catch {
    return fail(controller.signal.aborted ? "timeout" : "network", origin);
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverModels(
  options: DiscoverModelsOptions,
): Promise<DiscoveryResult> {
  const base = parseBase(options.baseUrl);
  if (!base) return { ok: false, category: "invalid-base-url" };
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const href = base.href.replace(/\/+$/, "");
  let failure: DiscoveryFailure | undefined;
  for (const suffix of ENDPOINT_SUFFIXES) {
    const outcome = await fetchEndpoint(
      new URL(`${href}${suffix}`),
      options.apiKey,
      base.origin,
      timeoutMs,
    );
    if (outcome.kind === "failure") {
      failure ??= outcome.failure;
      continue;
    }
    if (outcome.entries.length > 0)
      return { ok: true, entries: outcome.entries };
  }
  return failure ?? { ok: false, category: "empty", host: base.origin };
}
