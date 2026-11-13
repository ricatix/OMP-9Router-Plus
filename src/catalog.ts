// allow: SIZE_OK - Plan task 4 mandates one catalog module holding validation,
// matching, and the reviewed reasoning policy; splitting it would fork the
// domain surface the later OMP mapper consumes.
import type {
  CatalogProviderResolution,
  CatalogRouteMatch,
  CatalogThinkingPolicy,
  NineRouterLlmCatalog,
  ThinkingPolicyInput,
} from "./route-types.js";

const sourceFile =
  /^open-sse\/(?:providers\/registry\/(?:index|[^/]+)\.js|providers\/(?:index|schema)\.js|providers\/models\/(?:schema|helpers)\.js|config\/(?:providerModels|grokCli|kiroConstants)\.js|providers\/(?:thinkingLevels|capabilities)\.js|translator\/concerns\/thinkingUnified\.js)$/;

export const CATALOG_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
  "ultra",
] as const;

const catalogLevels: ReadonlySet<string> = new Set(CATALOG_LEVELS);
const rangeLevels: ReadonlySet<string> = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "on",
  "off",
]);
const providerFields = new Set([
  "id",
  "catalogKey",
  "aliases",
  "models",
  "modelsFetcher",
  "passthroughModels",
  "thinkingFormat",
]);
const modelFields = new Set([
  "id",
  "name",
  "kind",
  "upstreamModelId",
  "canonicalProvider",
  "canonicalModelId",
  "reasoning",
  "thinkingLevels",
  "thinkingEligible",
]);
const reasoningFields = new Set([
  "reasoning",
  "thinkingFormat",
  "thinkingCanDisable",
  "thinkingRange",
  "thinkingEffortSupported",
]);
const catalogFields = new Set([
  "sourceCommit",
  "sourceFiles",
  "providers",
  "routeOwners",
  "reasoningPicker",
]);
const maxCatalogId = 512,
  maxFormat = 64,
  maxPickerEntries = 32,
  maxLevels = 9,
  maxBudget = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const ownKeysWithin = (value: Record<string, unknown>, allowed: Set<string>) =>
  Object.keys(value).every((key) => allowed.has(key));

const safeString = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );

const uniqueLevels = (value: unknown, allowed: ReadonlySet<string>) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= maxLevels &&
  value.every((level) => typeof level === "string" && allowed.has(level)) &&
  new Set(value).size === value.length;

function validRange(value: unknown): boolean {
  if (value === null) return true;
  if (uniqueLevels(value, rangeLevels)) return true;
  if (!isRecord(value)) return false;
  if (Object.keys(value).length === 1 && "values" in value)
    return uniqueLevels(value.values, rangeLevels);
  if (Object.keys(value).length !== 2 || !("min" in value) || !("max" in value))
    return false;
  return (
    typeof value.min === "number" &&
    typeof value.max === "number" &&
    Number.isSafeInteger(value.min) &&
    Number.isSafeInteger(value.max) &&
    value.min >= 0 &&
    value.min <= value.max &&
    value.max <= maxBudget
  );
}

function validReasoning(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !ownKeysWithin(value, reasoningFields) ||
    (value.reasoning !== true && value.reasoning !== false)
  )
    return false;
  if (
    "thinkingEffortSupported" in value &&
    typeof value.thinkingEffortSupported !== "boolean"
  )
    return false;
  if (
    "thinkingFormat" in value &&
    value.thinkingFormat !== null &&
    !safeString(value.thinkingFormat, maxFormat)
  )
    return false;
  if (
    "thinkingCanDisable" in value &&
    typeof value.thinkingCanDisable !== "boolean"
  )
    return false;
  return !("thinkingRange" in value) || validRange(value.thinkingRange);
}

function validProvider(key: string, value: unknown): boolean {
  if (
    !isRecord(value) ||
    !ownKeysWithin(value, providerFields) ||
    !nonemptyString(value.id) ||
    value.id !== key ||
    !nonemptyString(value.catalogKey) ||
    !Array.isArray(value.aliases) ||
    !value.aliases.every(nonemptyString) ||
    !Array.isArray(value.models)
  )
    return false;
  if ("thinkingFormat" in value && !safeString(value.thinkingFormat, maxFormat))
    return false;
  if ("modelsFetcher" in value && value.modelsFetcher !== true) return false;
  if ("passthroughModels" in value && value.passthroughModels !== true)
    return false;
  return (
    new Set([value.catalogKey, ...value.aliases]).size ===
    value.aliases.length + 1
  );
}

function validModel(value: unknown): boolean {
  return (
    isRecord(value) &&
    ownKeysWithin(value, modelFields) &&
    nonemptyString(value.id) &&
    value.kind === "llm" &&
    ["name", "canonicalProvider", "canonicalModelId", "upstreamModelId"].every(
      (key) => !(key in value) || safeString(value[key], maxCatalogId),
    ) &&
    (!("reasoning" in value) || validReasoning(value.reasoning)) &&
    (!("thinkingLevels" in value) ||
      uniqueLevels(value.thinkingLevels, catalogLevels)) &&
    (!("thinkingEligible" in value) ||
      typeof value.thinkingEligible === "boolean")
  );
}

function validPicker(
  value: unknown,
  providers: Record<string, unknown>,
): boolean {
  if (
    !isRecord(value) ||
    !ownKeysWithin(value, new Set(["formatLevels", "patternLevels"])) ||
    !isRecord(value.formatLevels) ||
    Object.keys(value.formatLevels).length > maxPickerEntries ||
    !Object.entries(value.formatLevels).every(
      ([format, levels]) =>
        safeString(format, maxFormat) && uniqueLevels(levels, catalogLevels),
    ) ||
    !Array.isArray(value.patternLevels) ||
    value.patternLevels.length > maxPickerEntries
  )
    return false;
  const patterns = value.patternLevels;
  return (
    patterns.every(
      (entry) =>
        isRecord(entry) &&
        ownKeysWithin(entry, new Set(["provider", "pattern", "levels"])) &&
        (!("provider" in entry) ||
          (nonemptyString(entry.provider) &&
            Object.hasOwn(providers, entry.provider))) &&
        safeString(entry.pattern, maxCatalogId) &&
        uniqueLevels(entry.levels, catalogLevels),
    ) &&
    new Set(
      patterns.map((entry) =>
        JSON.stringify([entry.provider ?? null, entry.pattern]),
      ),
    ).size === patterns.length
  );
}

export function validateLlmCatalog(
  catalog: unknown,
): asserts catalog is NineRouterLlmCatalog {
  if (
    !isRecord(catalog) ||
    !ownKeysWithin(catalog, catalogFields) ||
    typeof catalog.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(catalog.sourceCommit)
  )
    throw new TypeError("Invalid LLM catalog sourceCommit");
  if (
    !Array.isArray(catalog.sourceFiles) ||
    catalog.sourceFiles.length === 0 ||
    !catalog.sourceFiles.every(
      (file) => safeString(file, maxCatalogId) && sourceFile.test(file),
    ) ||
    new Set(catalog.sourceFiles).size !== catalog.sourceFiles.length
  )
    throw new TypeError("Invalid LLM catalog sourceFiles");
  if (!isRecord(catalog.providers) || !isRecord(catalog.routeOwners))
    throw new TypeError("Invalid LLM catalog providers");

  const providers = catalog.providers;
  const routeKeys = new Map<string, string[]>();
  for (const [key, provider] of Object.entries(providers)) {
    if (!validProvider(key, provider))
      throw new TypeError("Invalid LLM catalog provider");
    const declared = provider as {
      catalogKey: string;
      aliases: readonly string[];
      models: readonly unknown[];
    };
    for (const routeKey of [declared.catalogKey, ...declared.aliases])
      routeKeys.set(routeKey, [...(routeKeys.get(routeKey) ?? []), key]);
    const modelIds = new Set<string>();
    for (const model of declared.models) {
      if (!validModel(model)) throw new TypeError("Invalid LLM catalog model");
      const id = (model as { id: string }).id;
      if (modelIds.has(id))
        throw new TypeError("Duplicate LLM catalog model id");
      modelIds.add(id);
    }
  }

  for (const [key, owners] of routeKeys)
    if (
      !nonemptyString(catalog.routeOwners[key]) ||
      !owners.includes(catalog.routeOwners[key])
    )
      throw new TypeError("Invalid LLM catalog route owner");
  for (const [key, owner] of Object.entries(catalog.routeOwners))
    if (!routeKeys.has(key) || !nonemptyString(owner))
      throw new TypeError("Orphan LLM catalog route owner");
  if (!validPicker(catalog.reasoningPicker, providers))
    throw new TypeError("Invalid LLM catalog reasoningPicker");
}

function splitRoute(
  routeId: unknown,
): { routeKey: string; modelId: string } | null {
  if (typeof routeId !== "string") return null;
  const slash = routeId.indexOf("/");
  if (slash <= 0 || slash === routeId.length - 1) return null;
  return {
    routeKey: routeId.slice(0, slash),
    modelId: routeId.slice(slash + 1),
  };
}

function ownerOf(
  routeKey: string,
  catalog: NineRouterLlmCatalog,
): string | null {
  if (!Object.hasOwn(catalog.routeOwners, routeKey)) return null;
  const owner = catalog.routeOwners[routeKey];
  return Object.hasOwn(catalog.providers, owner) ? owner : null;
}

export function resolveCatalogProvider(
  routeId: string,
  catalog: NineRouterLlmCatalog,
): CatalogProviderResolution | null {
  validateLlmCatalog(catalog);
  const route = splitRoute(routeId);
  if (!route) return null;
  const owner = ownerOf(route.routeKey, catalog);
  if (!owner) return null;
  const provider = catalog.providers[owner];
  return {
    routeKey: route.routeKey,
    providerId: provider.id,
    catalogKey: provider.catalogKey,
    dynamic:
      provider.modelsFetcher === true || provider.passthroughModels === true,
    provider,
    model: provider.models.find((entry) => entry.id === route.modelId) ?? null,
  };
}

export function matchLlmCatalogRoute(
  routeId: string,
  catalog: NineRouterLlmCatalog,
): CatalogRouteMatch | null {
  const resolution = resolveCatalogProvider(routeId, catalog);
  const model = resolution?.model;
  if (!resolution || !model) return null;
  return {
    providerId: resolution.providerId,
    catalogKey: resolution.catalogKey,
    modelId: model.id,
    canonicalProvider: model.canonicalProvider,
    canonicalModelId: model.canonicalModelId,
    provider: resolution.provider,
    model,
  };
}

const effortLevels: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const knownFormats: ReadonlySet<string> = new Set([
  "openai",
  "claude-adaptive",
  "claude-budget",
  "gemini-level",
  "gemini-budget",
  "zai",
  "qwen",
  "kimi",
  "deepseek",
  "commandcode",
  "minimax",
  "hunyuan",
  "step",
  "nous",
  "tokenrouter",
]);

const toggleFormats: ReadonlySet<string> = new Set(["zai", "minimax"]);
const offlessTransports: ReadonlySet<string> = new Set([
  "commandcode",
  "tokenrouter",
  "step",
  "nous",
  "openai-responses",
]);
const offlessFormats: ReadonlySet<string> = new Set([
  "commandcode",
  "tokenrouter",
  "step",
  "nous",
  "gemini-level",
]);
const toggleOfflessTransports: ReadonlySet<string> = new Set([
  "commandcode",
  "tokenrouter",
  "step",
]);
const kiroUnreachable: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "max",
  "ultra",
]);

const MAX_LIVE_LEVELS = 16;

const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const formatName = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 64 &&
  /^[a-z][a-z-]*$/.test(value)
    ? value
    : undefined;

const boolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const levelTokens: ReadonlySet<string> = new Set([...effortLevels, "thinking"]);

const liveLevelList = (input: unknown): readonly string[] | undefined => {
  if (!Array.isArray(input)) return undefined;
  const length = own(input, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length === 0 ||
    length > MAX_LIVE_LEVELS
  )
    return undefined;
  const levels: string[] = [];
  for (let index = 0; index < length; index++) {
    const item = own(input, String(index));
    if (
      typeof item !== "string" ||
      !levelTokens.has(item) ||
      levels.includes(item)
    )
      return undefined;
    levels.push(item);
  }
  return levels;
};

function matchesGlob(value: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

function patternLevels(
  input: ThinkingPolicyInput,
  providerId: string,
  modelId: string,
): readonly string[] | undefined {
  return input.catalog.reasoningPicker.patternLevels.find(
    (rule) =>
      (!rule.provider || rule.provider === providerId) &&
      matchesGlob(modelId, rule.pattern),
  )?.levels;
}

function catalogLevelsFor(
  input: ThinkingPolicyInput,
  format: string,
): readonly string[] | undefined {
  if (format === "tokenrouter")
    return ["low", "medium", "high", "xhigh", "max"];
  return input.catalog.reasoningPicker.formatLevels[format];
}

function policyFor(
  format: string,
  transport: string,
  levels: readonly string[],
  canDisable: boolean | undefined,
  providerId: string,
): CatalogThinkingPolicy | null {
  const explicitOff =
    !offlessTransports.has(transport) && !offlessFormats.has(format);
  const efforts: string[] = [];
  let toggle = false,
    disable = false;
  for (const level of levels) {
    if (level === "none" && (canDisable === false || !explicitOff)) continue;
    if (level === "thinking") {
      if (toggleFormats.has(format) && !toggleOfflessTransports.has(transport))
        toggle = true;
      continue;
    }
    if (effortLevels.has(level)) {
      if (level === "none" && toggleFormats.has(format)) {
        disable = true;
        continue;
      }
      efforts.push(level);
    }
  }
  if (efforts.length === 0 && !toggle && !disable) return null;
  if (providerId === "kiro" && format === "openai") {
    const kept = efforts.filter((level) => !kiroUnreachable.has(level));
    if (kept.length === 0) return null;
    efforts.length = 0;
    efforts.push(...kept);
  }
  return { format, transport, efforts, toggle, disable };
}

export function resolveThinkingPolicy(
  input: ThinkingPolicyInput,
): CatalogThinkingPolicy | null {
  if (input.reasoning !== true) return null;
  const route = splitRoute(input.routeId);
  if (!route) return null;
  const { routeKey, modelId } = route;
  validateLlmCatalog(input.catalog);
  const owner = own(input.catalog.routeOwners, routeKey);
  const provider =
    typeof owner === "string" && Object.hasOwn(input.catalog.providers, owner)
      ? input.catalog.providers[owner]
      : undefined;
  if (!provider) return null;
  const reviewed =
    provider.models.find((entry) => entry.id === modelId) ?? null;
  if (provider.id === "kiro" && reviewed?.thinkingEligible !== true)
    return null;
  const staticFormat =
    provider.thinkingFormat ?? reviewed?.reasoning?.thinkingFormat;
  const liveFormat = formatName(own(input.live, "thinkingFormat"));
  const format = liveFormat ?? staticFormat;
  if (!format || !knownFormats.has(format)) return null;
  const compatible =
    liveFormat === undefined ||
    staticFormat == null ||
    liveFormat === staticFormat;
  const canDisable =
    boolean(own(input.live, "thinkingCanDisable")) ??
    (compatible ? reviewed?.reasoning?.thinkingCanDisable : undefined);
  const levels = compatible
    ? (liveLevelList(input.liveLevels) ??
      reviewed?.thinkingLevels ??
      patternLevels(input, provider.id, modelId) ??
      catalogLevelsFor(input, format))
    : (liveLevelList(input.liveLevels) ?? catalogLevelsFor(input, format));
  if (!levels) return null;
  const transport =
    provider.id === "muse"
      ? "openai-responses"
      : (provider.thinkingFormat ?? format);
  return policyFor(format, transport, levels, canDisable, provider.id);
}
