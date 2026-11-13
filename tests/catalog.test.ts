// allow: SIZE_OK - Plan task 4 pins one audited catalog test file covering
// validation, matching, and the reviewed reasoning policy against a small fixture.
import { describe, expect, test } from "bun:test";
import {
  CATALOG_LEVELS,
  matchLlmCatalogRoute,
  resolveCatalogProvider,
  resolveThinkingPolicy,
  validateLlmCatalog,
} from "../src/catalog.js";
import { NINE_ROUTER_LLM_CATALOG } from "../src/generated/9router-llm-catalog.js";
import type { NineRouterLlmCatalog } from "../src/route-types.js";

// Small audited subset. The generated module carries the full pinned snapshot.
const FIXTURE: NineRouterLlmCatalog = {
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceFiles: ["open-sse/providers/registry/index.js"],
  providers: {
    codex: {
      id: "codex",
      catalogKey: "cx",
      aliases: [],
      models: [
        {
          id: "gpt-5.6-sol",
          kind: "llm",
          name: "GPT 5.6 Sol",
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
          canonicalProvider: "openai",
          canonicalModelId: "gpt-5.6-sol",
        },
        {
          id: "gpt-5.6-sol-review",
          kind: "llm",
          name: "GPT 5.6 Sol Review",
          upstreamModelId: "gpt-5.6-sol",
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
          canonicalProvider: "openai",
          canonicalModelId: "gpt-5.6-sol",
        },
        {
          id: "gpt-6.1-sol",
          kind: "llm",
          name: "GPT 6.1 Sol",
          thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
      ],
    },
    "grok-cli": {
      id: "grok-cli",
      catalogKey: "gcli",
      aliases: ["gb"],
      models: [
        {
          id: "grok-4.5-high",
          kind: "llm",
          name: "Grok 4.5 (High)",
          upstreamModelId: "grok-4.5",
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
      ],
    },
    "opencode-zen": {
      id: "opencode-zen",
      catalogKey: "opencode-zen",
      aliases: [],
      models: [
        {
          id: "glm-5.2",
          kind: "llm",
          name: "GLM 5.2",
          reasoning: {
            reasoning: true,
            thinkingFormat: "zai",
            thinkingCanDisable: false,
            thinkingRange: null,
            thinkingEffortSupported: true,
          },
        },
      ],
    },
    openrouter: {
      id: "openrouter",
      catalogKey: "openrouter",
      aliases: [],
      thinkingFormat: "openai",
      modelsFetcher: true,
      passthroughModels: true,
      models: [],
    },
    kiro: {
      id: "kiro",
      catalogKey: "kr",
      aliases: [],
      models: [
        {
          id: "claude-opus-5.5",
          kind: "llm",
          name: "Claude Opus 5.5",
          thinkingEligible: true,
          reasoning: {
            reasoning: true,
            thinkingFormat: "claude-adaptive",
            thinkingCanDisable: false,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
        {
          id: "claude-opus-4.5",
          kind: "llm",
          name: "Claude Opus 4.5",
          thinkingEligible: false,
          reasoning: {
            reasoning: true,
            thinkingFormat: "claude-budget",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
        {
          id: "gpt-5.6-sol",
          kind: "llm",
          name: "GPT 5.6 Sol",
          thinkingEligible: true,
          thinkingLevels: [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
          ],
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
      ],
    },
    muse: {
      id: "muse",
      catalogKey: "muse",
      aliases: [],
      models: [
        {
          id: "muse-spark-1.3",
          kind: "llm",
          name: "Muse Spark 1.3",
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
      ],
    },
    mmf: {
      id: "mmf",
      catalogKey: "mmf",
      aliases: [],
      models: [{ id: "owned", kind: "llm", name: "Owned" }],
    },
    "mimo-free": {
      id: "mimo-free",
      catalogKey: "mmf",
      aliases: [],
      modelsFetcher: true,
      passthroughModels: true,
      models: [{ id: "unreachable", kind: "llm", name: "Unreachable" }],
    },
  },
  routeOwners: {
    cx: "codex",
    gcli: "grok-cli",
    gb: "grok-cli",
    "opencode-zen": "opencode-zen",
    openrouter: "openrouter",
    kr: "kiro",
    muse: "muse",
    mmf: "mmf",
  },
  reasoningPicker: {
    formatLevels: {
      openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
      zai: ["none", "thinking"],
      minimax: ["none", "thinking"],
      "claude-adaptive": ["none", "low", "medium", "high", "xhigh", "max"],
      "claude-budget": ["none", "low", "medium", "high", "xhigh", "max"],
    },
    patternLevels: [
      {
        provider: "codex",
        pattern: "*gpt-5.6-sol*",
        levels: [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
        ],
      },
      { pattern: "*claude*4.6*", levels: ["none", "low", "medium", "high"] },
    ],
  },
};

const clone = (catalog: NineRouterLlmCatalog): NineRouterLlmCatalog =>
  structuredClone(catalog);

describe("reviewed catalog matching", () => {
  test("matches an exact route and preserves catalog entry identity", () => {
    // Given the reviewed subset; When a live ID resolves exactly.
    const result = matchLlmCatalogRoute("cx/gpt-5.6-sol", FIXTURE);
    // Then the owner, model and canonical identity come from the catalog.
    expect(result).toMatchObject({
      providerId: "codex",
      catalogKey: "cx",
      modelId: "gpt-5.6-sol",
      canonicalProvider: "openai",
      canonicalModelId: "gpt-5.6-sol",
    });
    expect(result?.provider).toBe(FIXTURE.providers.codex);
    expect(result?.model).toBe(FIXTURE.providers.codex.models[0]);
  });

  test("matches provider alias route keys including upstream model ids", () => {
    // Given aliases "gb" and "gcli" for one provider.
    for (const routeId of ["gcli/grok-4.5-high", "gb/grok-4.5-high"]) {
      // When matched; Then both resolve to the same reviewed entry.
      const result = matchLlmCatalogRoute(routeId, FIXTURE);
      expect(result).toMatchObject({
        providerId: "grok-cli",
        catalogKey: "gcli",
        modelId: "grok-4.5-high",
      });
      expect(result?.model.upstreamModelId).toBe("grok-4.5");
    }
  });

  test("matches canonical metadata of a review variant route", () => {
    // Given a review SKU that maps upstream to a canonical model.
    const result = matchLlmCatalogRoute("cx/gpt-5.6-sol-review", FIXTURE);
    // Then the reviewed canonical mapping survives matching.
    expect(result?.model.upstreamModelId).toBe("gpt-5.6-sol");
    expect(result?.canonicalProvider).toBe("openai");
    expect(result?.canonicalModelId).toBe("gpt-5.6-sol");
  });

  test("matches the source-order owner of a colliding route key", () => {
    // Given "mmf" declared by mimo-free and mmf with owner mmf.
    expect(matchLlmCatalogRoute("mmf/owned", FIXTURE)?.providerId).toBe("mmf");
    // Then the non-owning provider inventory stays unreachable.
    expect(matchLlmCatalogRoute("mmf/unreachable", FIXTURE)).toBeNull();
  });

  test("matches only discovered inventory for dynamic providers", () => {
    // Given a dynamic provider with no static models.
    const provider = resolveCatalogProvider("openrouter/new-model", FIXTURE);
    expect(provider).toMatchObject({
      routeKey: "openrouter",
      providerId: "openrouter",
      catalogKey: "openrouter",
      dynamic: true,
    });
    // Then no catalog model is invented from the live ID.
    expect(matchLlmCatalogRoute("openrouter/new-model", FIXTURE)).toBeNull();
  });

  test("matches the pinned generated snapshot provenance", () => {
    // Given the generated module; Then provenance and shape stay pinned.
    validateLlmCatalog(NINE_ROUTER_LLM_CATALOG);
    expect(NINE_ROUTER_LLM_CATALOG.sourceCommit).toBe(
      "1855aa44473e88feac9d3f131b9c0c5fc9706b68",
    );
    expect(NINE_ROUTER_LLM_CATALOG.sourceFiles).toHaveLength(156);
    expect(NINE_ROUTER_LLM_CATALOG.sourceFiles).toEqual(
      [...NINE_ROUTER_LLM_CATALOG.sourceFiles].sort(),
    );
    expect(new Set(NINE_ROUTER_LLM_CATALOG.sourceFiles).size).toBe(156);
    expect(Object.keys(NINE_ROUTER_LLM_CATALOG.providers)).toHaveLength(145);
    expect(
      Object.values(NINE_ROUTER_LLM_CATALOG.providers).flatMap(
        (provider) => provider.models,
      ),
    ).toHaveLength(896);
    expect(NINE_ROUTER_LLM_CATALOG.routeOwners.mmf).toBe("mmf");
    const sol = matchLlmCatalogRoute("cx/gpt-5.6-sol", NINE_ROUTER_LLM_CATALOG);
    expect(sol?.model).toMatchObject({
      id: "gpt-5.6-sol",
      canonicalProvider: "openai",
      canonicalModelId: "gpt-5.6-sol",
    });
    expect(
      matchLlmCatalogRoute("gcli/grok-4.5-high", NINE_ROUTER_LLM_CATALOG)?.model
        .reasoning,
    ).toMatchObject({ reasoning: true, thinkingFormat: "openai" });
  });
});

describe("reviewed thinking policy", () => {
  test("resolves an exact per-model effort ladder", () => {
    // Given a model with reviewed thinkingLevels.
    const policy = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      catalog: FIXTURE,
    });
    // Then only reviewed efforts are offered, with no invented toggle.
    expect(policy).toEqual({
      format: "openai",
      transport: "openai",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      toggle: false,
      disable: false,
    });
  });

  test("falls back to the reviewed glob ladder for a matching model", () => {
    // Given a model without exact levels but with a provider-scoped pattern.
    const policy = resolveThinkingPolicy({
      routeId: "cx/gpt-5.6-sol",
      reasoning: true,
      catalog: FIXTURE,
    });
    // Then the audited pattern levels apply in router order.
    expect(policy?.efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  test("resolves toggle-only formats without fabricating an effort", () => {
    // Given a zai route whose ladder cannot disable thinking.
    const policy = resolveThinkingPolicy({
      routeId: "opencode-zen/glm-5.2",
      reasoning: true,
      catalog: FIXTURE,
    });
    // Then only the enable toggle is representable.
    expect(policy).toEqual({
      format: "zai",
      transport: "zai",
      efforts: [],
      toggle: true,
      disable: false,
    });
  });

  test("uses the provider transport for a dynamic model id", () => {
    // Given a live id absent from the catalog on a provider with a transport.
    const policy = resolveThinkingPolicy({
      routeId: "openrouter/new-model",
      reasoning: true,
      catalog: FIXTURE,
    });
    // Then the reviewed format ladder applies without adding a model.
    expect(policy?.format).toBe("openai");
    expect(policy?.efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("omits off where the reviewed transport cannot express it", () => {
    // Given the muse transport that cannot encode an explicit off.
    const policy = resolveThinkingPolicy({
      routeId: "muse/muse-spark-1.3",
      reasoning: true,
      catalog: FIXTURE,
    });
    // Then the off level is dropped instead of being guessed.
    expect(policy?.transport).toBe("openai-responses");
    expect(policy?.efforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("gates kiro routes on reviewed thinking eligibility", () => {
    // Given one eligible and one ineligible kiro model.
    const eligible = resolveThinkingPolicy({
      routeId: "kr/claude-opus-5.5",
      reasoning: true,
      catalog: FIXTURE,
    });
    const ineligible = resolveThinkingPolicy({
      routeId: "kr/claude-opus-4.5",
      reasoning: true,
      catalog: FIXTURE,
    });
    // Then only the eligible route exposes a ladder.
    expect(eligible?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(ineligible).toBeNull();
  });

  test("drops unreachable kiro efforts on an openai route", () => {
    // Given a kiro route reviewed as openai with a wide ladder.
    const policy = resolveThinkingPolicy({
      routeId: "kr/gpt-5.6-sol",
      reasoning: true,
      catalog: FIXTURE,
    });
    // Then only the efforts the router transport accepts survive.
    expect(policy).toEqual({
      format: "openai",
      transport: "openai",
      efforts: ["low", "medium", "high", "xhigh"],
      toggle: false,
      disable: false,
    });
  });

  test("prefers live format over reviewed levels when they disagree", () => {
    // Given a live minimax format on a model reviewed as openai.
    const policy = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      live: { thinkingFormat: "minimax" },
      catalog: FIXTURE,
    });
    // Then the reviewed effort ladder is discarded for the toggle control.
    expect(policy).toEqual({
      format: "minimax",
      transport: "minimax",
      efforts: [],
      toggle: true,
      disable: true,
    });
  });

  test("prefers live selectable levels and ignores malformed ones", () => {
    // Given a valid live ladder and then a malformed one.
    const valid = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      liveLevels: ["low", "high"],
      catalog: FIXTURE,
    });
    const malformed = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      liveLevels: ["low", "invented", "low"],
      catalog: FIXTURE,
    });
    // Then only the valid ladder wins; malformed input keeps reviewed levels.
    expect(valid?.efforts).toEqual(["low", "high"]);
    expect(malformed?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("emits a toggle only for reviewed toggle formats", () => {
    // Given the same live `thinking` marker on a toggle and a non-toggle format.
    const toggle = resolveThinkingPolicy({
      routeId: "opencode-zen/glm-5.2",
      reasoning: true,
      liveLevels: ["thinking"],
      catalog: FIXTURE,
    });
    const effortOnly = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      live: { thinkingFormat: "openai" },
      liveLevels: ["thinking"],
      catalog: FIXTURE,
    });
    // Then only the toggle format exposes an enabled control.
    expect(toggle).toEqual({
      format: "zai",
      transport: "zai",
      efforts: [],
      toggle: true,
      disable: false,
    });
    expect(effortOnly).toBeNull();
  });

  test("returns no policy when the ladder has no reachable control", () => {
    // Given a level list that reduces to nothing on a non-toggle format.
    const policy = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      live: { thinkingFormat: "openai", thinkingCanDisable: false },
      liveLevels: ["none"],
      catalog: FIXTURE,
    });
    // Then absence of control is reported as no policy, not an empty surface.
    expect(policy).toBeNull();
  });

  test("rejects a live ladder containing an unknown level", () => {
    // Given unique live levels where one token is not a router level.
    const policy = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      liveLevels: ["low", "invented"],
      catalog: FIXTURE,
    });
    // Then the whole live ladder is discarded rather than partially trusted.
    expect(policy?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("requires the final reasoning decision to be true", () => {
    // Given non-true reasoning values from live or catalog metadata.
    for (const reasoning of [false, undefined, "true", null, 1]) {
      // Then no ladder is offered.
      expect(
        resolveThinkingPolicy({
          routeId: "cx/gpt-6.1-sol",
          reasoning,
          catalog: FIXTURE,
        }),
      ).toBeNull();
    }
  });

  test("refuses a reviewed format the router does not define", () => {
    // Given a provider whose reviewed format is not in the router vocabulary.
    const custom = clone(FIXTURE);
    (
      custom.providers.openrouter as { thinkingFormat?: string }
    ).thinkingFormat = "unstable-custom";
    // Then no ladder or toggle is invented from an unknown format.
    expect(
      resolveThinkingPolicy({
        routeId: "openrouter/new-model",
        reasoning: true,
        catalog: custom,
      }),
    ).toBeNull();
  });

  test("refuses an unknown live format even with live levels", () => {
    // Given live metadata claiming a format the router, catalog, and host do
    // not define, together with a plausible effort ladder.
    const policy = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      live: { thinkingFormat: "unstable-custom" },
      liveLevels: ["low", "high"],
      catalog: FIXTURE,
    });
    // Then the unknown format is refused instead of forwarded to the mapper.
    expect(policy).toBeNull();
  });

  test("does not read live getters or inherited live fields", () => {
    // Given live metadata whose own format is a throwing getter.
    const live = Object.create({ thinkingCanDisable: false });
    Object.defineProperty(live, "thinkingFormat", {
      get() {
        throw new Error("getter invoked");
      },
    });
    // Then the reviewed ladder is used and no getter runs.
    const policy = resolveThinkingPolicy({
      routeId: "cx/gpt-6.1-sol",
      reasoning: true,
      live,
      catalog: FIXTURE,
    });
    expect(policy?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("catalog boundary rejection", () => {
  test("rejects malformed provenance", () => {
    // Given a commit that is not a full SHA and unsafe source paths.
    const cases: unknown[] = [
      { ...FIXTURE, sourceCommit: "master" },
      { ...FIXTURE, sourceFiles: undefined },
      { ...FIXTURE, sourceFiles: [] },
      { ...FIXTURE, sourceFiles: "open-sse/providers/registry/index.js" },
      { ...FIXTURE, sourceFiles: ["bad.js"] },
      { ...FIXTURE, sourceFiles: ["open-sse/providers/pricing.js"] },
      {
        ...FIXTURE,
        sourceFiles: [
          "open-sse/providers/registry/index.js",
          "open-sse/providers/registry/index.js",
        ],
      },
    ];
    // Then every malformed provenance value is refused.
    for (const catalog of cases)
      expect(() => validateLlmCatalog(catalog)).toThrow();
  });

  test("rejects provider, route and model identity collisions", () => {
    // Given records whose ids or route keys collide.
    const cases: unknown[] = [
      { ...FIXTURE, providers: { wrong: FIXTURE.providers.codex } },
      {
        ...FIXTURE,
        providers: {
          one: { ...FIXTURE.providers.codex, id: "one" },
          two: {
            ...FIXTURE.providers["grok-cli"],
            id: "two",
            catalogKey: "cx",
          },
        },
        routeOwners: { cx: "two" },
      },
      {
        ...FIXTURE,
        providers: {
          codex: {
            ...FIXTURE.providers.codex,
            aliases: ["cx"],
          },
          "grok-cli": FIXTURE.providers["grok-cli"],
        },
      },
      {
        ...FIXTURE,
        providers: {
          ...FIXTURE.providers,
          codex: {
            ...FIXTURE.providers.codex,
            models: [
              { id: "same", kind: "llm" },
              { id: "same", kind: "llm" },
            ],
          },
        },
      },
    ];
    // Then duplicate owners and duplicate model ids are refused.
    for (const catalog of cases)
      expect(() => validateLlmCatalog(catalog)).toThrow();
  });

  test("rejects orphan, missing and foreign route owners", () => {
    // Given route owner maps that do not describe the declared routes.
    const cases: unknown[] = [
      { ...FIXTURE, routeOwners: { cx: "codex" } },
      {
        ...FIXTURE,
        routeOwners: { ...FIXTURE.routeOwners, orphan: "codex" },
      },
      {
        ...FIXTURE,
        routeOwners: { ...FIXTURE.routeOwners, cx: "grok-cli" },
      },
      { ...FIXTURE, routeOwners: undefined },
    ];
    // Then the catalog is refused instead of matching an ambiguous owner.
    for (const catalog of cases)
      expect(() => validateLlmCatalog(catalog)).toThrow();
  });

  test("rejects non-LLM models and malformed reasoning metadata", () => {
    // Given models that would leak inventory or unsafe capability shapes.
    const model = (patch: Record<string, unknown>) => ({
      ...FIXTURE,
      providers: {
        ...FIXTURE.providers,
        codex: {
          ...FIXTURE.providers.codex,
          models: [{ id: "m", kind: "llm", name: "M", ...patch }],
        },
      },
    });
    const cases: unknown[] = [
      {
        ...FIXTURE,
        providers: {
          bad: {
            id: "bad",
            catalogKey: "bad",
            aliases: [],
            models: [{ id: "image", kind: "image" }],
          },
        },
      },
      model({ reasoning: true }),
      model({ reasoning: { reasoning: "true" } }),
      model({ reasoning: { reasoning: true, thinkingFormat: 1 } }),
      model({ reasoning: { reasoning: true, thinkingFormat: "" } }),
      model({ reasoning: { reasoning: true, thinkingFormat: "x".repeat(65) } }),
      model({ reasoning: { reasoning: true, thinkingCanDisable: "false" } }),
      model({ reasoning: { reasoning: true, thinkingRange: "low" } }),
      model({ reasoning: { reasoning: true, thinkingRange: [] } }),
      model({ reasoning: { reasoning: true, thinkingRange: ["low", "low"] } }),
      model({ reasoning: { reasoning: true, thinkingRange: ["unknown"] } }),
      model({
        reasoning: { reasoning: true, thinkingRange: { values: "low" } },
      }),
      model({
        reasoning: { reasoning: true, thinkingRange: { min: 1.5, max: 2 } },
      }),
      model({
        reasoning: { reasoning: true, thinkingRange: { min: 2, max: 1 } },
      }),
      model({
        reasoning: {
          reasoning: true,
          thinkingRange: { min: 0, max: 1_000_001 },
        },
      }),
      model({
        reasoning: {
          reasoning: true,
          thinkingRange: { min: 0, max: 1, extra: 2 },
        },
      }),
      model({ thinkingLevels: [] }),
      model({ thinkingLevels: ["low", "low"] }),
      model({ thinkingLevels: ["unknown"] }),
      model({ thinkingLevels: Array(10).fill("low") }),
      model({ thinkingEligible: "true" }),
      model({ canonicalProvider: "" }),
      model({ canonicalModelId: "x\n" }),
      model({ upstreamModelId: 1 }),
      model({ canonicalProvider: "x".repeat(513) }),
      model({ name: 1 }),
    ];
    // Then each malformed model is refused at the boundary.
    for (const catalog of cases)
      expect(() => validateLlmCatalog(catalog)).toThrow();
  });

  test("rejects malformed dynamic markers and provider fields", () => {
    // Given dynamic flags that are not the reviewed literal true.
    const cases: unknown[] = [
      {
        ...FIXTURE,
        providers: {
          ...FIXTURE.providers,
          openrouter: { ...FIXTURE.providers.openrouter, modelsFetcher: "yes" },
        },
      },
      {
        ...FIXTURE,
        providers: {
          ...FIXTURE.providers,
          openrouter: { ...FIXTURE.providers.openrouter, passthroughModels: 1 },
        },
      },
      {
        ...FIXTURE,
        providers: {
          ...FIXTURE.providers,
          openrouter: { ...FIXTURE.providers.openrouter, thinkingFormat: "" },
        },
      },
    ];
    // Then invalid provider fields are refused.
    for (const catalog of cases)
      expect(() => validateLlmCatalog(catalog)).toThrow();
    // And an empty alias fails the provider check itself, not a later owner
    // lookup, so the diagnostic names the provider.
    expect(() =>
      validateLlmCatalog({
        ...FIXTURE,
        providers: {
          ...FIXTURE.providers,
          openrouter: { ...FIXTURE.providers.openrouter, aliases: [""] },
        },
      }),
    ).toThrow("Invalid LLM catalog provider");
  });

  test("rejects malformed and unbounded reasoning pickers", () => {
    // Given picker tables that exceed reviewed bounds or shapes.
    const picker = (patch: Record<string, unknown>) => ({
      ...FIXTURE,
      reasoningPicker: { ...FIXTURE.reasoningPicker, ...patch },
    });
    const cases: unknown[] = [
      picker({ formatLevels: { fmt: [] } }),
      picker({ formatLevels: { fmt: ["low", "low"] } }),
      picker({ formatLevels: { fmt: ["unknown"] } }),
      picker({ formatLevels: { fmt: Array(10).fill("low") } }),
      picker({ formatLevels: { ["x".repeat(65)]: ["low"] } }),
      picker({
        formatLevels: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`f${index}`, ["low"]]),
        ),
      }),
      picker({ patternLevels: [{ pattern: "", levels: ["low"] }] }),
      picker({
        patternLevels: [{ pattern: "x".repeat(513), levels: ["low"] }],
      }),
      picker({ patternLevels: [{ pattern: "*", levels: ["low", "low"] }] }),
      picker({ patternLevels: [{ pattern: "*", levels: ["unknown"] }] }),
      picker({
        patternLevels: [{ pattern: "*", levels: Array(10).fill("low") }],
      }),
      picker({
        patternLevels: [
          { pattern: "*", levels: ["low"] },
          { pattern: "*", levels: ["high"] },
        ],
      }),
      picker({
        patternLevels: [{ provider: "openai", pattern: "*", levels: ["low"] }],
      }),
      picker({
        patternLevels: Array.from({ length: 33 }, (_, index) => ({
          pattern: `p${index}`,
          levels: ["low"],
        })),
      }),
      picker({ formatLevels: undefined }),
      { ...FIXTURE, reasoningPicker: undefined },
    ];
    // Then each malformed picker is refused.
    for (const catalog of cases)
      expect(() => validateLlmCatalog(catalog)).toThrow();
  });

  test("rejects nested, unknown, wrong-case and unknown-provider routes", () => {
    // Given route ids the reviewed matcher cannot resolve exactly.
    const cases = [
      "cx/gpt-5.6-sol/extra",
      "unknown/gpt-5.6-sol",
      "gcli/grok-4.5-HIGH",
      "cx/GPT 5.6 Sol",
      "gcli",
      "/grok-4.5-high",
      "gcli/",
      "",
      "__proto__/gpt-5.6-sol",
      "mimo-free/unreachable",
    ];
    // Then no route is guessed from a model name or partial id.
    for (const routeId of cases)
      expect(matchLlmCatalogRoute(routeId, FIXTURE)).toBeNull();
  });

  test("resolves a provider without inventing missing static inventory", () => {
    // Given ids with an owned route key but no reviewed static entry.
    const owned = ["cx/gpt-5.6-sol/extra", "cx/GPT 5.6 Sol", "kr/new-model"];
    // Then the provider resolves with a null model, never a fabricated one.
    for (const routeId of owned) {
      const resolution = resolveCatalogProvider(routeId, FIXTURE);
      expect(resolution?.model).toBeNull();
      expect(matchLlmCatalogRoute(routeId, FIXTURE)).toBeNull();
    }
    // And unowned or malformed route keys resolve nothing at all.
    for (const routeId of [
      "unknown/gpt-5.6-sol",
      "gcli",
      "/grok-4.5-high",
      "gcli/",
      "",
      "__proto__/gpt-5.6-sol",
      "mimo-free/unreachable",
    ])
      expect(resolveCatalogProvider(routeId, FIXTURE)).toBeNull();
  });

  test("never matches a model id by partial prefix", () => {
    // Given reviewed ids where one id is a textual prefix of another.
    expect(matchLlmCatalogRoute("cx/gpt-5.6-sol", FIXTURE)?.modelId).toBe(
      "gpt-5.6-sol",
    );
    // Then a truncated live id resolves no model at all.
    for (const routeId of ["cx/gpt-5.6", "cx/gpt-5", "cx/gpt"]) {
      const resolution = resolveCatalogProvider(routeId, FIXTURE);
      expect(resolution?.providerId).toBe("codex");
      expect(resolution?.model).toBeNull();
      expect(matchLlmCatalogRoute(routeId, FIXTURE)).toBeNull();
    }
  });

  test("rejects a mutated clone even after the original validated", () => {
    // Given a valid catalog already validated in this process.
    validateLlmCatalog(FIXTURE);
    // When a fresh invalid object arrives; Then it is still validated.
    const broken = clone(FIXTURE);
    broken.sourceCommit = "master";
    expect(() => matchLlmCatalogRoute("cx/gpt-5.6-sol", broken)).toThrow();
  });
});

describe("catalog level vocabulary", () => {
  test("keeps the reviewed level order stable", () => {
    // Given the exported vocabulary; Then router order is unchanged.
    expect(CATALOG_LEVELS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "thinking",
      "ultra",
    ]);
  });
});
