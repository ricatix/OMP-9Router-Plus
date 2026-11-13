// allow: SIZE_OK - task 5 owns one models.dev enrichment cache module at src/models-dev.ts.
/**
 * Bounded models.dev metadata enrichment with a 24 hour on-disk cache.
 *
 * The module owns both the network boundary and its cache because the cache is
 * single-use: only the two public metadata catalogs are stored, never a
 * 9Router roster, API key, or server URL. Every failure path is nonfatal and
 * degrades to empty enrichment so model registration can continue.
 */
import {
  type FileHandle,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API_URL = "https://models.dev/api.json";
const MODELS_URL = "https://models.dev/models.json";
const MAX_API_BYTES = 5 * 1_048_576;
const MAX_MODELS_BYTES = 1_048_576;
const MAX_PROVIDERS = 500;
const MAX_MODELS_PER_PROVIDER = 5000;
const MAX_MODELS = 20_000;
const MAX_MODEL_KEYS = 32;
const MAX_ID_CHARS = 512;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const MODELS_DEV_CACHE_DIR = join(
  homedir(),
  ".cache",
  "omp-9router-plus",
);
export const MODELS_DEV_REQUEST_TIMEOUT_MS = 15_000;

type CacheName = "models-dev-api" | "models-dev-models";
type ApiCatalog = Record<string, unknown>;
type ModelCatalog = Record<string, unknown>;

const CACHE_FILENAMES: Readonly<Record<CacheName, string>> = {
  "models-dev-api": "models.dev.api.json",
  "models-dev-models": "models.dev.models.json",
};

export interface ModelsDevModel {
  id: string;
  name: string;
  family?: string;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  [key: string]: unknown;
}

export interface ModelsDevLookup {
  providerModel: ModelsDevModel | null;
  modelOnly: ModelsDevModel | null;
}

export type ModelsDevFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ModelsDevClientOptions {
  readonly fetch?: ModelsDevFetch;
  readonly apiUrl?: string;
  readonly modelsUrl?: string;
  readonly cacheDir?: string;
}

export interface ModelsDevClient {
  lookupCanonical(provider: string, modelRef: string): Promise<ModelsDevLookup>;
  lookupExact(modelRef: string): Promise<ModelsDevModel | null>;
  lookupUniqueLeaf(modelRef: string): Promise<ModelsDevModel | null>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const ownValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const isSafeId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_CHARS &&
  ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });

function isValidModel(value: unknown): value is ModelsDevModel {
  if (!isPlainObject(value) || Object.keys(value).length > MAX_MODEL_KEYS)
    return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function validateApi(value: unknown): ApiCatalog {
  if (!isPlainObject(value) || Object.keys(value).length > MAX_PROVIDERS)
    return {};
  for (const providerId of Object.keys(value)) {
    if (!isSafeId(providerId)) return {};
    const provider = ownValue(value, providerId);
    if (!isPlainObject(provider)) return {};
    const models = ownValue(provider, "models");
    if (
      !isPlainObject(models) ||
      Object.keys(models).length > MAX_MODELS_PER_PROVIDER
    )
      return {};
    for (const modelId of Object.keys(models))
      if (!isSafeId(modelId) || !isValidModel(ownValue(models, modelId)))
        return {};
  }
  return value;
}

function validateModels(value: unknown): ModelCatalog {
  if (!isPlainObject(value) || Object.keys(value).length > MAX_MODELS)
    return {};
  for (const modelId of Object.keys(value))
    if (!isSafeId(modelId) || !isValidModel(ownValue(value, modelId)))
      return {};
  return value;
}

function ownModel(
  catalog: Record<string, unknown>,
  id: string,
): ModelsDevModel | null {
  const descriptor = Object.getOwnPropertyDescriptor(catalog, id);
  if (!descriptor || !("value" in descriptor)) return null;
  return isValidModel(descriptor.value) ? descriptor.value : null;
}

function apiProviderModel(
  api: ApiCatalog,
  provider: string,
  modelId: string,
): ModelsDevModel | null {
  const providerValue = ownValue(api, provider);
  if (!isPlainObject(providerValue)) return null;
  const models = ownValue(providerValue, "models");
  if (!isPlainObject(models)) return null;
  return ownModel(models, modelId);
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<unknown | null> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function readBoundedCache(
  file: string,
  maxBytes: number,
): Promise<unknown | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const read = await handle.read(
        buffer,
        bytesRead,
        maxBytes + 1 - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > maxBytes) return null;
    const entry: unknown = JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    if (!isPlainObject(entry)) return null;
    const timestamp = ownValue(entry, "timestamp");
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      !Object.hasOwn(entry, "data")
    )
      return null;
    return Date.now() - timestamp < CACHE_TTL_MS
      ? ownValue(entry, "data")
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeCacheAtomic(
  dir: string,
  name: CacheName,
  data: unknown,
  maxBytes: number,
): Promise<void> {
  const filename = CACHE_FILENAMES[name];
  const content = JSON.stringify({ timestamp: Date.now(), data });
  if (Buffer.byteLength(content) > maxBytes) return;
  await mkdir(dir, { recursive: true });
  const target = join(dir, filename);
  const temp = join(
    dir,
    `.${filename.replace(/\.json$/, "")}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function createLoader<T extends object>(
  cacheDir: string,
  fetchImpl: ModelsDevFetch,
  name: CacheName,
  url: string,
  maxBytes: number,
  validate: (value: unknown) => T,
): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= (async () => {
      const cached = await readBoundedCache(
        join(cacheDir, CACHE_FILENAMES[name]),
        maxBytes,
      );
      const cachedValid = validate(cached);
      if (
        cached !== null &&
        (Object.keys(cachedValid).length > 0 ||
          (isPlainObject(cached) && Object.keys(cached).length === 0))
      )
        return cachedValid;
      try {
        const data = await readResponseBody(
          await fetchImpl(url, {
            signal: AbortSignal.timeout(MODELS_DEV_REQUEST_TIMEOUT_MS),
          }),
          maxBytes,
        );
        const valid = validate(data);
        if (data !== null && Object.keys(valid).length > 0) {
          try {
            await writeCacheAtomic(cacheDir, name, data, maxBytes);
          } catch {
            // Cache write failures must never block metadata use.
          }
        }
        return valid;
      } catch {
        return {} as T;
      }
    })();
    return promise;
  };
}

export function createModelsDevClient(
  options: ModelsDevClientOptions = {},
): ModelsDevClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiUrl = options.apiUrl ?? API_URL;
  const modelsUrl = options.modelsUrl ?? MODELS_URL;
  const cacheDir = options.cacheDir ?? MODELS_DEV_CACHE_DIR;
  const api = createLoader(
    cacheDir,
    fetchImpl,
    "models-dev-api",
    apiUrl,
    MAX_API_BYTES,
    validateApi,
  );
  const models = createLoader(
    cacheDir,
    fetchImpl,
    "models-dev-models",
    modelsUrl,
    MAX_MODELS_BYTES,
    validateModels,
  );

  return {
    async lookupCanonical(provider, modelRef) {
      const [apiCatalog, modelCatalog] = await Promise.all([api(), models()]);
      const local = modelRef.slice(modelRef.indexOf("/") + 1);
      return {
        providerModel:
          apiProviderModel(apiCatalog, provider, local) ??
          apiProviderModel(apiCatalog, provider, modelRef),
        modelOnly: ownModel(modelCatalog, modelRef),
      };
    },
    async lookupExact(modelRef) {
      return ownModel(await models(), modelRef);
    },
    async lookupUniqueLeaf(modelRef) {
      const catalog = await models();
      const leaf = modelRef.slice(modelRef.lastIndexOf("/") + 1);
      const matches = Object.keys(catalog).filter(
        (key) => key.slice(key.lastIndexOf("/") + 1) === leaf,
      );
      if (matches.length !== 1) return null;
      const only = matches[0];
      return only === undefined ? null : ownModel(catalog, only);
    },
  };
}

const production = createModelsDevClient();

export async function lookupModelsDev(
  provider: string | undefined,
  modelRef: string,
): Promise<ModelsDevLookup> {
  return provider
    ? production.lookupCanonical(provider, modelRef)
    : {
        providerModel: null,
        modelOnly: await production.lookupExact(modelRef),
      };
}

export async function lookupModel(
  modelRef: string,
): Promise<ModelsDevModel | null> {
  return production.lookupUniqueLeaf(modelRef);
}
