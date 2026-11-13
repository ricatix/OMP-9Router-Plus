// allow: SIZE_OK - Plan task 6 pins one mapper module; splitting it would
// create out-of-scope source files.
/**
 * Maps discovered 9Router entries to native OMP model configuration.
 *
 * Authority is fixed: live discovery metadata wins, the reviewed catalog fills
 * gaps, and models.dev only enriches non-capability data (cost and limits).
 * Nothing here invents a capability, model ID, effort ladder, or default level.
 */
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { matchLlmCatalogRoute, resolveThinkingPolicy } from "./catalog.js";
import type { DiscoveryEntry } from "./discovery.js";
import { NINE_ROUTER_LLM_CATALOG } from "./generated/9router-llm-catalog.js";
import type {
  ModelsDevClient,
  ModelsDevLookup,
  ModelsDevModel,
} from "./models-dev.js";
import type {
  CatalogRouteMatch,
  CatalogThinkingPolicy,
  NineRouterLlmCatalog,
} from "./route-types.js";

/**
 * Runtime provider model shape. The public `ProviderModelConfig` omits
 * `supportsTools`, while `ProviderConfig.models` accepts it at runtime; this
 * intersection is structurally assignable without casts or host patches.
 */
export type OmpModelConfig = ProviderModelConfig & {
  supportsTools: boolean;
};

export interface MapModelOptions {
  readonly catalog?: NineRouterLlmCatalog;
  readonly enrichment?: ModelsDevLookup;
}

export interface MapModelsOptions {
  readonly catalog?: NineRouterLlmCatalog;
  /** When omitted, mapping runs without models.dev enrichment. */
  readonly lookup?: ModelsDevClient;
}

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;
const MAX_LIMIT = 10_000_000;
const MAX_COST = 1_000_000;

type ThinkingConfig = NonNullable<ProviderModelConfig["thinking"]>;
type Compat = NonNullable<ProviderModelConfig["compat"]>;

const EMPTY_ENRICHMENT: ModelsDevLookup = Object.freeze({
  providerModel: null,
  modelOnly: null,
});

/**
 * Native thinking has no boolean toggle. The host represents an enabled-only
 * model as off plus one effort; "high" is the host's own carrier for that
 * shape, so no default level or budget is invented here.
 */
const TOGGLE_CARRIER = THINKING_EFFORTS.find((effort) => effort === "high");

const ownValue = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const safeText = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value === value.trim() &&
  ![...value].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  )
    ? value
    : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  value === true ? true : value === false ? false : undefined;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= MAX_LIMIT
    ? value
    : undefined;

const price = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_COST
    ? value
    : undefined;

const limitPair = (
  context: unknown,
  output: unknown,
): { contextWindow: number; maxTokens: number } | undefined => {
  const contextWindow = positiveInt(context);
  const maxTokens = positiveInt(output);
  return contextWindow !== undefined && maxTokens !== undefined
    ? { contextWindow, maxTokens }
    : undefined;
};

const modelLimit = (model: ModelsDevModel | null) => {
  const limit = ownValue(model, "limit");
  return isRecord(limit)
    ? limitPair(ownValue(limit, "context"), ownValue(limit, "output"))
    : undefined;
};

const zeroCost = (): ProviderModelConfig["cost"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

/**
 * Cost rows are accepted only when at least one field is a valid number; every
 * accepted field is then used verbatim, missing or invalid fields become 0.
 * Zero means unknown/unpriced, not a free-model claim.
 */
const modelCost = (
  model: ModelsDevModel | null,
): ProviderModelConfig["cost"] | undefined => {
  const cost = ownValue(model, "cost");
  if (!isRecord(cost)) return undefined;
  const input = price(ownValue(cost, "input"));
  const output = price(ownValue(cost, "output"));
  const cacheRead =
    price(ownValue(cost, "cache_read")) ?? price(ownValue(cost, "cacheRead"));
  const cacheWrite =
    price(ownValue(cost, "cache_write")) ?? price(ownValue(cost, "cacheWrite"));
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  )
    return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
  };
};

const matchRoute = (
  id: string,
  catalog: NineRouterLlmCatalog,
): CatalogRouteMatch | null => {
  try {
    return matchLlmCatalogRoute(id, catalog);
  } catch {
    return null;
  }
};

function thinkingFor(
  id: string,
  reasoning: boolean,
  live: Record<string, unknown> | undefined,
  catalog: NineRouterLlmCatalog,
): { thinking?: ThinkingConfig; compat: Compat } {
  const base: Compat = { trustExplicitThinkingOnly: true };
  if (!reasoning) return { compat: base };
  let policy: CatalogThinkingPolicy | null = null;
  try {
    // Discovery nests router thinking metadata in capabilities while the
    // resolver reads it at the top level of `live`; nested values win and a
    // top-level shape still works for callers that provide one.
    const capabilities =
      live === undefined ? undefined : recordOf(ownValue(live, "capabilities"));
    const resolverLive =
      live === undefined
        ? undefined
        : {
            thinkingFormat:
              ownValue(capabilities, "thinkingFormat") ??
              ownValue(live, "thinkingFormat"),
            thinkingCanDisable:
              ownValue(capabilities, "thinkingCanDisable") ??
              ownValue(live, "thinkingCanDisable"),
          };
    policy = resolveThinkingPolicy({
      routeId: id,
      reasoning,
      live: resolverLive,
      liveLevels:
        live === undefined ? undefined : ownValue(live, "thinking_levels"),
      catalog,
    });
  } catch {
    policy = null;
  }
  if (policy === null) return { compat: base };

  const efforts = THINKING_EFFORTS.filter((effort) =>
    policy.efforts.includes(effort),
  );
  if (efforts.length > 0)
    return {
      thinking: { mode: "effort", efforts },
      compat: {
        ...base,
        thinkingFormat: "openai",
        supportsReasoningEffort: true,
      },
    };
  if (policy.toggle && TOGGLE_CARRIER !== undefined)
    return {
      thinking: { mode: "effort", efforts: [TOGGLE_CARRIER] },
      compat: {
        ...base,
        thinkingFormat: "zai",
        supportsReasoningEffort: false,
        // The host emits an enabled intent only through this mode. The router
        // clamps the explicit off to its minimum when the route cannot disable
        // thinking, so omission would silently drop the enabled request.
        reasoningDisableMode: "zai-thinking-disabled",
      },
    };
  return { compat: base };
}

function safeModel(id: string): OmpModelConfig {
  return {
    id,
    name: id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    supportsTools: false,
    cost: zeroCost(),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { trustExplicitThinkingOnly: true },
  };
}

/**
 * Maps one discovered entry. Malformed metadata is treated as unknown and
 * never throws; the caller can keep mapping sibling models.
 */
export function mapModel(
  entry: DiscoveryEntry,
  options: MapModelOptions = {},
): OmpModelConfig {
  try {
    const catalog = options.catalog ?? NINE_ROUTER_LLM_CATALOG;
    const enrichment = options.enrichment ?? EMPTY_ENRICHMENT;
    const id = entry.id;
    const live = recordOf(ownValue(entry, "live"));
    const capabilities =
      live === undefined ? undefined : recordOf(ownValue(live, "capabilities"));
    const route = matchRoute(id, catalog);

    const liveReasoning =
      capabilities === undefined
        ? undefined
        : booleanValue(ownValue(capabilities, "reasoning"));
    const reasoning =
      liveReasoning ??
      (route === null ? false : route.model.reasoning?.reasoning === true);
    const supportsTools =
      capabilities !== undefined &&
      booleanValue(ownValue(capabilities, "tools")) === true;
    // The OMP API input union is text|image; PDF is never widened to image.
    const vision =
      capabilities !== undefined &&
      booleanValue(ownValue(capabilities, "vision")) === true;

    const name =
      (live === undefined ? undefined : safeText(ownValue(live, "name"))) ??
      safeText(route?.model.name) ??
      id;

    const limit = (capabilities === undefined
      ? undefined
      : limitPair(
          ownValue(capabilities, "contextWindow"),
          ownValue(capabilities, "maxOutput"),
        )) ??
      (live === undefined
        ? undefined
        : limitPair(
            ownValue(live, "context_length"),
            ownValue(live, "max_completion_tokens"),
          )) ??
      modelLimit(enrichment.providerModel) ??
      modelLimit(enrichment.modelOnly) ?? {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
      };

    const cost =
      modelCost(enrichment.providerModel) ??
      modelCost(enrichment.modelOnly) ??
      zeroCost();
    const { thinking, compat } = thinkingFor(id, reasoning, live, catalog);

    return {
      id,
      name,
      api: "openai-completions",
      reasoning,
      ...(thinking === undefined ? {} : { thinking }),
      input: vision ? ["text", "image"] : ["text"],
      supportsTools,
      cost,
      contextWindow: limit.contextWindow,
      maxTokens: limit.maxTokens,
      compat,
    };
  } catch {
    return safeModel(entry.id);
  }
}

async function lookupFor(
  id: string,
  catalog: NineRouterLlmCatalog,
  client: ModelsDevClient,
): Promise<ModelsDevLookup> {
  const route = matchRoute(id, catalog);
  if (route === null)
    return {
      providerModel: null,
      modelOnly: await client.lookupUniqueLeaf(id),
    };
  const provider = route.canonicalProvider ?? route.providerId;
  const model =
    route.canonicalModelId ?? route.model.upstreamModelId ?? route.modelId;
  return client.lookupCanonical(provider, `${provider}/${model}`);
}

/**
 * Maps a discovered roster. Each lookup and each model is independent: a
 * metadata failure leaves that model conservative while siblings survive.
 */
export async function mapModels(
  entries: readonly DiscoveryEntry[],
  options: MapModelsOptions = {},
): Promise<OmpModelConfig[]> {
  const catalog = options.catalog ?? NINE_ROUTER_LLM_CATALOG;
  const models: OmpModelConfig[] = [];
  for (const entry of entries) {
    let enrichment: ModelsDevLookup = EMPTY_ENRICHMENT;
    if (options.lookup !== undefined)
      try {
        enrichment = await lookupFor(entry.id, catalog, options.lookup);
      } catch {
        enrichment = EMPTY_ENRICHMENT;
      }
    models.push(mapModel(entry, { catalog, enrichment }));
  }
  return models;
}
