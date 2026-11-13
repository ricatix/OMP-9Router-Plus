/**
 * models.yml connection boundary for the native 9Router provider.
 *
 * The reader is deliberately narrow: it only understands the connection keys
 * this extension owns (`baseUrl`, `apiKey`, `api`). Anything that would make
 * the host apply manual roster, discovery, override, or auth behavior is
 * rejected instead of silently ignored.
 *
 * The reader never writes files, never reads `.env`, never executes
 * command-backed values, and never includes configured values in diagnostics.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export const NINE_ROUTER_PROVIDER_ID = "9router" as const;

const MODELS_FILE = "models.yml";
const MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_API = "openai-completions" as const;
const ALLOWED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "baseUrl",
  "apiKey",
  "api",
]);

export type NineRouterApi = typeof DEFAULT_API;

/**
 * Connection values the extension owns.
 *
 * `baseUrl` is normalized by removing trailing slashes so callers can append
 * endpoint paths. Model IDs are never derived from it. `apiKeyConfig` is the
 * exact string from models.yml; `resolvedApiKey` is one native-style
 * resolution (`env[apiKeyConfig] || apiKeyConfig`) used only for discovery.
 * Runtime registration must receive `apiKeyConfig`.
 */
export interface NineRouterConnection {
  readonly providerId: typeof NINE_ROUTER_PROVIDER_ID;
  readonly baseUrl: string;
  readonly api: NineRouterApi;
  readonly apiKeyConfig: string;
  readonly resolvedApiKey: string;
}

export type NineRouterConfigErrorCode =
  | "config-missing"
  | "config-unreadable"
  | "config-too-large"
  | "config-invalid-yaml"
  | "config-invalid-shape"
  | "provider-missing"
  | "provider-invalid"
  | "unsupported-provider-key"
  | "invalid-base-url"
  | "invalid-api"
  | "invalid-api-key"
  | "command-api-key";

/** Typed, redacted failure returned for every expected configuration problem. */
export class NineRouterConfigError extends Error {
  override readonly name = "NineRouterConfigError";
  readonly providerId = NINE_ROUTER_PROVIDER_ID;

  constructor(
    readonly code: NineRouterConfigErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ReadNineRouterConnectionOptions {
  /** Native agent directory to inspect. Defaults to the active host `getAgentDir()`. */
  readonly agentDir?: string;
}

export type ReadNineRouterConnectionResult =
  | { readonly ok: true; readonly connection: NineRouterConnection }
  | { readonly ok: false; readonly error: NineRouterConfigError };

/**
 * Read `providers.9router` from `<agentDir>/models.yml`.
 *
 * Expected failures are returned as a typed result so startup code can keep
 * OMP usable and emit a redacted diagnostic. At most 1 MiB is read before
 * parsing.
 */
export async function readNineRouterConnection(
  options: ReadNineRouterConnectionOptions = {},
): Promise<ReadNineRouterConnectionResult> {
  const agentDir = options.agentDir ?? getAgentDir();
  const configPath = join(agentDir, MODELS_FILE);

  let fileStats: Awaited<ReturnType<typeof stat>>;
  try {
    fileStats = await stat(configPath);
  } catch (error) {
    return fail(
      isMissingFile(error) ? "config-missing" : "config-unreadable",
      isMissingFile(error)
        ? `${MODELS_FILE} was not found in the active OMP agent directory.`
        : `${MODELS_FILE} could not be read.`,
    );
  }

  if (!fileStats.isFile())
    return fail("config-unreadable", `${MODELS_FILE} is not a regular file.`);
  if (fileStats.size > MAX_CONFIG_BYTES) {
    return fail("config-too-large", `${MODELS_FILE} exceeds the 1 MiB limit.`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(configPath);
  } catch {
    return fail("config-unreadable", `${MODELS_FILE} could not be read.`);
  }
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    return fail("config-too-large", `${MODELS_FILE} exceeds the 1 MiB limit.`);
  }

  let document: unknown;
  try {
    document = Bun.YAML.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail("config-invalid-yaml", `${MODELS_FILE} is not valid YAML.`);
  }

  if (!isRecord(document)) {
    return fail(
      "config-invalid-shape",
      `${MODELS_FILE} must contain a mapping at the document root.`,
    );
  }
  if (!Object.hasOwn(document, "providers")) {
    return fail(
      "provider-missing",
      `${MODELS_FILE} does not define providers.9router.`,
    );
  }
  const providers = document.providers;
  if (!isRecord(providers)) {
    return fail("config-invalid-shape", "providers must be a mapping.");
  }
  if (!Object.hasOwn(providers, NINE_ROUTER_PROVIDER_ID)) {
    return fail(
      "provider-missing",
      `${MODELS_FILE} does not define providers.9router.`,
    );
  }
  const provider = providers[NINE_ROUTER_PROVIDER_ID];
  if (!isRecord(provider)) {
    return fail("provider-invalid", "providers.9router must be a mapping.");
  }

  const unsupportedKeys = Object.keys(provider).filter(
    (key) => !ALLOWED_PROVIDER_KEYS.has(key),
  );
  if (unsupportedKeys.length > 0) {
    const keys = unsupportedKeys.map((key) => JSON.stringify(key)).join(", ");
    return fail(
      "unsupported-provider-key",
      `providers.9router contains unsupported keys: ${keys}. This extension only reads baseUrl, apiKey, and api; remove the others from models.yml.`,
    );
  }

  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (baseUrl === undefined) {
    return fail(
      "invalid-base-url",
      "providers.9router.baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment.",
    );
  }

  const api = provider.api;
  if (api !== undefined && api !== DEFAULT_API) {
    return fail(
      "invalid-api",
      `providers.9router.api must be "${DEFAULT_API}".`,
    );
  }

  const apiKeyConfig = provider.apiKey;
  if (typeof apiKeyConfig !== "string" || apiKeyConfig.trim() === "") {
    return fail(
      "invalid-api-key",
      "providers.9router.apiKey must be a non-empty string.",
    );
  }
  if (apiKeyConfig.startsWith("!")) {
    return fail(
      "command-api-key",
      "providers.9router.apiKey must not be command-backed. Use a literal key or an environment variable name.",
    );
  }

  return {
    ok: true,
    connection: {
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl,
      api: DEFAULT_API,
      apiKeyConfig,
      resolvedApiKey: resolveApiKey(apiKeyConfig),
    },
  };
}

function fail(
  code: NineRouterConfigErrorCode,
  message: string,
): ReadNineRouterConnectionResult {
  return { ok: false, error: new NineRouterConfigError(code, message) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value);
  if (authority === null || authority[1] === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Native `resolveConfigValue` semantics without command execution:
 * `env[valueConfig] || valueConfig`, with an exact-case environment lookup.
 */
function resolveApiKey(apiKeyConfig: string): string {
  return exactEnv(apiKeyConfig) || apiKeyConfig;
}

function exactEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  for (const key of Object.keys(process.env)) {
    if (key === name) return value;
  }
  return undefined;
}
