/**
 * Domain types for the reviewed 9Router LLM catalog.
 *
 * These types describe router-owned inventory and capability metadata. They are
 * intentionally narrower than any host model shape: the OMP adapter composes
 * them at its own boundary.
 */

/** Reviewed router reasoning capability flags for one model. */
export interface NineRouterCapabilities {
  reasoning?: boolean;
  thinkingFormat?: string | null;
  thinkingCanDisable?: boolean;
  thinkingRange?: unknown;
  readonly thinkingEffortSupported?: boolean;
}

/** One reviewed static LLM entry. Only LLM inventory is projected. */
export interface StaticLlmModel {
  id: string;
  name?: string;
  kind: "llm";
  upstreamModelId?: string;
  canonicalProvider?: string;
  canonicalModelId?: string;
  reasoning?: NineRouterCapabilities;
  readonly thinkingLevels?: readonly string[];
  readonly thinkingEligible?: boolean;
}

/** One reviewed provider with its route keys and static inventory. */
export interface StaticLlmProvider {
  id: string;
  catalogKey: string;
  aliases: readonly string[];
  models: readonly StaticLlmModel[];
  modelsFetcher?: true;
  passthroughModels?: true;
  readonly thinkingFormat?: string;
}

/** Full reviewed snapshot: provenance, providers, route owners, pickers. */
export interface NineRouterLlmCatalog {
  sourceCommit: string;
  sourceFiles: readonly string[];
  providers: Readonly<Record<string, StaticLlmProvider>>;
  routeOwners: Readonly<Record<string, string>>;
  reasoningPicker: {
    formatLevels: Readonly<Record<string, readonly string[]>>;
    patternLevels: readonly {
      readonly provider?: string;
      readonly pattern: string;
      readonly levels: readonly string[];
    }[];
  };
}

/** Route-key resolution for a live ID, independent of static inventory. */
export interface CatalogProviderResolution {
  /** Route key exactly as it appeared before the first slash. */
  routeKey: string;
  providerId: string;
  catalogKey: string;
  /** True when the provider declares a models fetcher or passthrough roster. */
  dynamic: boolean;
  provider: StaticLlmProvider;
  /** Reviewed static entry for this route, or null for dynamic inventory. */
  model: StaticLlmModel | null;
}

/** Exact catalog match, including the reviewed entry identities. */
export interface CatalogRouteMatch {
  providerId: string;
  catalogKey: string;
  modelId: string;
  canonicalProvider?: string;
  canonicalModelId?: string;
  provider: StaticLlmProvider;
  model: StaticLlmModel;
}

/** Reviewed reasoning control surface derived from route metadata. */
export interface CatalogThinkingPolicy {
  /** Reviewed or live router thinking format. */
  format: string;
  /** Router transport used to encode this format on the wire. */
  transport: string;
  /** Effort levels in router order; `none` appears only as an effort. */
  efforts: readonly string[];
  /** An enabled-only toggle is expressible (`thinking` level). */
  toggle: boolean;
  /** An explicit thinking-off control is expressible. */
  disable: boolean;
}

/** Inputs for reviewing one live ID against the catalog. */
export interface ThinkingPolicyInput {
  readonly routeId: string;
  /** Final reasoning decision; anything other than `true` yields no policy. */
  readonly reasoning: unknown;
  readonly live?: unknown;
  readonly liveLevels?: unknown;
  readonly catalog: NineRouterLlmCatalog;
}
