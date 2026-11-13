// allow: SIZE_OK - Plan task 6 pins one mapper authority/invalid matrix file;
// splitting it would create out-of-scope test files.
/**
 * Task 6 mapper tests. The matrix proves live metadata authority, atomic
 * limit/cost projection, native thinking intersections, and conservative
 * behavior for unknown or malformed metadata. No network is contacted.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import {
  acceptDiscoveryEntries,
  type DiscoveryEntry,
} from "../src/discovery.js";
import {
  mapModel,
  mapModels,
  type OmpModelConfig,
} from "../src/model-mapper.js";
import type {
  ModelsDevClient,
  ModelsDevLookup,
  ModelsDevModel,
} from "../src/models-dev.js";
import type { NineRouterLlmCatalog } from "../src/route-types.js";

const FIXTURE: NineRouterLlmCatalog = {
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceFiles: ["open-sse/providers/registry/index.js"],
  providers: {
    fixture: {
      id: "fixture",
      catalogKey: "fx",
      aliases: [],
      models: [
        {
          id: "known",
          kind: "llm",
          name: "Catalog Known",
          canonicalProvider: "canon",
          canonicalModelId: "known-upstream",
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
        {
          id: "catalog-false",
          kind: "llm",
          name: "Catalog False",
          reasoning: {
            reasoning: true,
            thinkingFormat: "openai",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
        {
          id: "mystery",
          kind: "llm",
          name: "Catalog Mystery",
          reasoning: {
            reasoning: true,
            thinkingFormat: "mystery",
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
      ],
    },
    toggle: {
      id: "toggle",
      catalogKey: "tx",
      aliases: [],
      thinkingFormat: "zai",
      models: [
        {
          id: "toggle",
          kind: "llm",
          name: "Catalog Toggle",
          reasoning: {
            reasoning: true,
            thinkingCanDisable: true,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
        {
          id: "toggle-locked",
          kind: "llm",
          name: "Catalog Toggle Locked",
          reasoning: {
            reasoning: true,
            thinkingCanDisable: false,
            thinkingRange: null,
            thinkingEffortSupported: false,
          },
        },
      ],
    },
  },
  routeOwners: { fx: "fixture", tx: "toggle" },
  reasoningPicker: {
    formatLevels: {
      openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
      zai: ["none", "thinking"],
    },
    patternLevels: [],
  },
};

const entry = (
  id: string,
  live: DiscoveryEntry["live"] = {},
): DiscoveryEntry => ({ id, kind: "llm", live });

const modelsDev = (value: Record<string, unknown>): ModelsDevModel => ({
  id: "fixture-model",
  name: "Fixture Model",
  ...value,
});

const enrichment = (
  providerModel: ModelsDevModel | null = null,
  modelOnly: ModelsDevModel | null = null,
): ModelsDevLookup => ({ providerModel, modelOnly });

const thinkingSnapshot = (
  model: OmpModelConfig,
): { mode: string; efforts: string[] } | undefined =>
  model.thinking === undefined
    ? undefined
    : {
        mode: model.thinking.mode,
        efforts: [...model.thinking.efforts],
      };

describe("model authority", () => {
  test("authority: live name and capabilities win over catalog and models.dev", () => {
    // Given a known route whose live metadata contradicts both lower sources.
    const model = mapModel(
      entry("fx/known", {
        name: "Live Known",
        capabilities: {
          reasoning: true,
          tools: true,
          vision: true,
          pdf: true,
          contextWindow: 100_000,
          maxOutput: 20_000,
          thinkingFormat: "openai",
          thinkingCanDisable: true,
        },
        thinking_levels: ["low", "high", "ultra"],
      }),
      {
        catalog: FIXTURE,
        enrichment: enrichment(
          modelsDev({
            name: "Models.dev Name",
            reasoning: false,
            tools: true,
            vision: true,
            modalities: { input: ["image", "pdf"], output: ["text"] },
            limit: { context: 999_999, output: 888_888 },
            cost: { input: 3, output: 6, cache_read: 0.3, cache_write: 0.6 },
          }),
        ),
      },
    );

    // Then the live identity, capability and limit pair are preserved verbatim.
    expect(model.id).toBe("fx/known");
    expect(model.name).toBe("Live Known");
    expect(model.api).toBe("openai-completions");
    expect(model.reasoning).toBe(true);
    expect(model.supportsTools).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(100_000);
    expect(model.maxTokens).toBe(20_000);
    expect(model.cost).toEqual({
      input: 3,
      output: 6,
      cacheRead: 0.3,
      cacheWrite: 0.6,
    });
    expect(thinkingSnapshot(model)).toEqual({
      mode: "effort",
      efforts: ["low", "high"],
    });
    expect(model.compat).toEqual({
      trustExplicitThinkingOnly: true,
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
    });
  });

  test("authority: top-level live limits win only as a complete pair", () => {
    // Given an incomplete live capability pair and a complete top-level pair.
    const model = mapModel(
      entry("fx/known", {
        capabilities: { contextWindow: 50_000 },
        context_length: 64_000,
        max_completion_tokens: 8_192,
      }),
      {
        catalog: FIXTURE,
        enrichment: enrichment(
          modelsDev({ limit: { context: 200_000, output: 30_000 } }),
        ),
      },
    );

    // Then the complete top-level pair wins atomically over models.dev.
    expect(model.contextWindow).toBe(64_000);
    expect(model.maxTokens).toBe(8_192);
  });

  test("authority: models.dev fills limits and cost without mixing sources", () => {
    // Given no live limits and two enrichment rows with different prices.
    const model = mapModel(entry("fx/known"), {
      catalog: FIXTURE,
      enrichment: enrichment(
        modelsDev({
          limit: { context: 128_000, output: 16_384 },
          cost: { input: 1, output: 2, cache_read: 0.1 },
        }),
        null,
      ),
    });

    // Then the provider row supplies a complete pair and a complete cost row.
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16_384);
    expect(model.cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0,
    });
  });

  test("authority: catalog name is used when live name is absent", () => {
    // Given a catalog entry with a reviewed name and no live name.
    const model = mapModel(
      entry("fx/catalog-false", {
        capabilities: { reasoning: false, tools: false, vision: false },
      }),
      { catalog: FIXTURE },
    );

    // Then the reviewed name is used and false capabilities stay false.
    expect(model.name).toBe("Catalog False");
    expect(model.reasoning).toBe(false);
    expect(model.supportsTools).toBe(false);
    expect(model.input).toEqual(["text"]);
    expect(model.thinking).toBeUndefined();
  });

  test("authority: toggle-only policy maps to native enabled/disabled", () => {
    // Given a zai-style route whose reviewed levels are only none/thinking.
    const model = mapModel(
      entry("tx/toggle", { capabilities: { reasoning: true } }),
      { catalog: FIXTURE },
    );

    // Then native thinking carries one host effort, no budget and no default.
    expect(thinkingSnapshot(model)).toEqual({
      mode: "effort",
      efforts: ["high"],
    });
    expect(model.thinking).not.toHaveProperty("defaultLevel");
    expect(model.compat).toEqual({
      trustExplicitThinkingOnly: true,
      thinkingFormat: "zai",
      supportsReasoningEffort: false,
      reasoningDisableMode: "zai-thinking-disabled",
    });
  });

  test("authority: live capability format suppresses a reviewed openai ladder", () => {
    // Given live thinking metadata nested where the discovery parser puts it.
    const model = mapModel(
      entry("fx/known", {
        capabilities: { reasoning: true, thinkingFormat: "mystery" },
        thinking_levels: ["low", "high"],
      }),
      { catalog: FIXTURE },
    );

    // Then the unknown live format wins over the reviewed openai route.
    expect(model.reasoning).toBe(true);
    expect(model.thinking).toBeUndefined();
    expect(model.compat).toEqual({ trustExplicitThinkingOnly: true });
  });

  test("authority: live capability zai format beats a reviewed openai route", () => {
    // Given a reviewed openai route whose live metadata reports a zai toggle.
    const model = mapModel(
      entry("fx/known", {
        capabilities: { reasoning: true, thinkingFormat: "zai" },
        thinking_levels: ["thinking"],
      }),
      { catalog: FIXTURE },
    );

    // Then the live format selects the toggle carrier, not the openai ladder.
    expect(thinkingSnapshot(model)).toEqual({
      mode: "effort",
      efforts: ["high"],
    });
    expect(model.compat).toMatchObject({
      thinkingFormat: "zai",
      supportsReasoningEffort: false,
    });
  });

  test("authority: live canDisable true beats a reviewed toggle that locks it", () => {
    // Given a reviewed locked toggle whose live route allows turning it off.
    const model = mapModel(
      entry("tx/toggle-locked", {
        capabilities: { reasoning: true, thinkingCanDisable: true },
      }),
      { catalog: FIXTURE },
    );

    // Then live authority supplies the off control even though the host only
    // expresses it through the zai disable mode.
    expect(model.compat).toEqual({
      trustExplicitThinkingOnly: true,
      thinkingFormat: "zai",
      supportsReasoningEffort: false,
      reasoningDisableMode: "zai-thinking-disabled",
    });
  });

  test("authority: locked toggle still emits an enable-capable compat", () => {
    // Given a reviewed zai toggle that cannot turn thinking off.
    const model = mapModel(
      entry("tx/toggle-locked", { capabilities: { reasoning: true } }),
      { catalog: FIXTURE },
    );

    // Then omission is never used: the host needs the zai mode to send an
    // enabled intent, and the router clamps the explicit off to its minimum.
    expect(thinkingSnapshot(model)).toEqual({
      mode: "effort",
      efforts: ["high"],
    });
    expect(model.compat).toEqual({
      trustExplicitThinkingOnly: true,
      thinkingFormat: "zai",
      supportsReasoningEffort: false,
      reasoningDisableMode: "zai-thinking-disabled",
    });
  });

  test("authority: discovered live zai format survives parser to mapper", () => {
    // Given the actual discovery parser output shape for a live zai route.
    const [parsed] = acceptDiscoveryEntries({
      data: [
        {
          id: "fx/known",
          capabilities: { reasoning: true, thinkingFormat: "zai" },
          thinking_levels: ["thinking"],
        },
      ],
    });
    expect(parsed).toBeDefined();
    const model = mapModel(parsed as DiscoveryEntry, { catalog: FIXTURE });

    // Then the nested live thinking format is forwarded to the resolver.
    expect(thinkingSnapshot(model)).toEqual({
      mode: "effort",
      efforts: ["high"],
    });
    expect(model.compat).toMatchObject({ thinkingFormat: "zai" });
  });

  test("authority: live levels intersect the native effort enum", () => {
    // Given a route with representable, unknown and non-effort tokens.
    const model = mapModel(
      entry("fx/known", {
        capabilities: { reasoning: true, thinkingFormat: "openai" },
        thinking_levels: ["low", "ultra", "max"],
      }),
      { catalog: FIXTURE },
    );

    // Then only native efforts survive, in host order.
    expect(thinkingSnapshot(model)).toEqual({
      mode: "effort",
      efforts: ["low", "max"],
    });
  });

  test("authority: supportsTools false is structurally assignable to ProviderConfig", () => {
    // Given a model with tools explicitly false.
    const models: OmpModelConfig[] = [
      mapModel(
        entry("fx/catalog-false", {
          capabilities: { reasoning: false, tools: false, vision: false },
        }),
        { catalog: FIXTURE },
      ),
    ];
    const config: ProviderConfig = {
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "task-6-test-token",
      api: "openai-completions",
      models,
    };

    // Then the runtime object retains the false value.
    expect(config.models).toHaveLength(1);
    expect(models[0]?.supportsTools).toBe(false);
  });

  test("authority: PDF capability never becomes image input", () => {
    // Given pdf true without vision.
    const model = mapModel(
      entry("fx/known", {
        capabilities: { reasoning: false, pdf: true, vision: false },
      }),
      { catalog: FIXTURE },
    );

    // Then the OMP input remains text-only.
    expect(model.input).toEqual(["text"]);
  });

  test("authority: missing cost fields are zero, not invented", () => {
    // Given a valid cost row with only one priced field.
    const model = mapModel(entry("fx/known"), {
      catalog: FIXTURE,
      enrichment: enrichment(modelsDev({ cost: { input: 1 } })),
    });

    // Then the absent fields are zero.
    expect(model.cost).toEqual({
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("authority: malformed cost and limit values are ignored per field", () => {
    // Given non-numeric and out-of-range metadata.
    const row = modelsDev({
      limit: { context: 128_000, output: 16_384 },
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
    });
    Object.defineProperty(row.cost, "input", { value: "1" });
    Object.defineProperty(row.cost, "output", { value: -2 });
    Object.defineProperty(row.cost, "cache_read", {
      value: Number.POSITIVE_INFINITY,
    });
    const model = mapModel(entry("fx/known"), {
      catalog: FIXTURE,
      enrichment: enrichment(row),
    });

    // Then every invalid field falls to zero and the limit pair survives.
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0.2,
    });
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16_384);
  });
});

describe("unknown and invalid metadata", () => {
  test("unknown and invalid: unknown thinking format invents no ladder", () => {
    // Given a reviewed and live format outside the known vocabulary.
    const model = mapModel(
      entry("fx/mystery", {
        capabilities: {
          reasoning: true,
          thinkingFormat: "mystery",
          thinkingCanDisable: true,
        },
      }),
      { catalog: FIXTURE },
    );

    // Then reasoning stays true, but no thinking dial is offered.
    expect(model.reasoning).toBe(true);
    expect(model.thinking).toBeUndefined();
    expect(model.compat).toEqual({ trustExplicitThinkingOnly: true });
  });

  test("unknown and invalid: invalid levels are replaced, never emitted", () => {
    // Given duplicate and unknown live levels.
    const model = mapModel(
      entry("fx/known", {
        capabilities: { reasoning: true, thinkingFormat: "openai" },
        thinking_levels: ["bogus", "low", "low"],
      }),
      { catalog: FIXTURE },
    );

    // Then the reviewed ladder is used and no invalid token escapes.
    expect(thinkingSnapshot(model)).toEqual({
      mode: "effort",
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
    });
  });

  test("unknown and invalid: live false cannot be re-enabled by models.dev", () => {
    // Given live false capabilities and a poisoned enrichment row.
    const model = mapModel(
      entry("fx/catalog-false", {
        capabilities: { reasoning: false, tools: false, vision: false },
      }),
      {
        catalog: FIXTURE,
        enrichment: enrichment(
          modelsDev({
            reasoning: true,
            tools: true,
            vision: true,
            modalities: { input: ["image", "pdf"], output: ["text"] },
          }),
        ),
      },
    );

    // Then no lower source re-enables a capability.
    expect(model.reasoning).toBe(false);
    expect(model.supportsTools).toBe(false);
    expect(model.input).toEqual(["text"]);
    expect(model.thinking).toBeUndefined();
  });

  test("unknown and invalid: unknown route keeps every ID and no ladder", async () => {
    // Given IDs without a reviewed route.
    const entries = [
      entry("zz/unknown", { capabilities: { reasoning: true } }),
      entry("left/right/slashes", { capabilities: { reasoning: true } }),
    ];

    // Then both IDs are retained and reasoning has no invented dial.
    const models = await mapModels(entries, { catalog: FIXTURE });
    expect(models.map((model) => model.id)).toEqual([
      "zz/unknown",
      "left/right/slashes",
    ]);
    for (const model of models) {
      expect(model.thinking).toBeUndefined();
      expect(model.compat).toEqual({ trustExplicitThinkingOnly: true });
    }
  });

  test("unknown and invalid: malformed metadata is conservative per model", async () => {
    // Given an accessor that would throw if invoked and a healthy sibling.
    const broken = entry("zz/broken");
    Object.defineProperty(broken, "live", {
      enumerable: true,
      get() {
        throw new Error("accessor must not run");
      },
    });

    // Then the broken entry maps conservatively and the sibling survives.
    const models = await mapModels([broken, entry("fx/known")], {
      catalog: FIXTURE,
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "zz/broken",
      name: "zz/broken",
      reasoning: false,
      supportsTools: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(models[0]?.thinking).toBeUndefined();
    expect(models[1]?.id).toBe("fx/known");
  });

  test("unknown and invalid: models.dev lookup failure is nonfatal", async () => {
    // Given a client whose every lookup rejects.
    const failing: ModelsDevClient = {
      lookupCanonical: async () => {
        throw new Error("metadata offline");
      },
      lookupExact: async () => {
        throw new Error("metadata offline");
      },
      lookupUniqueLeaf: async () => {
        throw new Error("metadata offline");
      },
    };

    // Then models still map with conservative defaults.
    const models = await mapModels([entry("fx/known"), entry("zz/unknown")], {
      catalog: FIXTURE,
      lookup: failing,
    });
    expect(models.map((model) => model.id)).toEqual(["fx/known", "zz/unknown"]);
    for (const model of models) {
      expect(model.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(model.contextWindow).toBe(32_768);
      expect(model.maxTokens).toBe(4_096);
    }
  });

  test("unknown and invalid: models.dev values never become capabilities", () => {
    // Given enrichment with only poisoned capability and invalid numeric data.
    const row = modelsDev({
      reasoning: true,
      tools: true,
      vision: true,
      modalities: { input: ["image", "pdf"], output: ["text"] },
      limit: { context: 128_000, output: 16_384 },
      cost: { input: 1, output: 2 },
    });
    Object.defineProperty(row.limit, "context", { value: "128000" });
    Object.defineProperty(row.cost, "input", { value: "free" });
    const model = mapModel(entry("zz/unknown"), {
      catalog: FIXTURE,
      enrichment: enrichment(row),
    });

    // Then capabilities stay false and invalid numbers never reach limits/cost.
    expect(model.reasoning).toBe(false);
    expect(model.supportsTools).toBe(false);
    expect(model.input).toEqual(["text"]);
    expect(model.thinking).toBeUndefined();
    expect(model.contextWindow).toBe(32_768);
    expect(model.maxTokens).toBe(4_096);
    expect(model.cost).toEqual({
      input: 0,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("unknown and invalid: inherited and accessor cost fields are ignored", () => {
    // Given a cost row whose values live on the prototype or an accessor.
    const prototype = { input: 9, output: 9, cache_read: 9, cache_write: 9 };
    const cost = Object.create(prototype) as Record<string, unknown>;
    Object.defineProperty(cost, "cache_write", {
      enumerable: true,
      get() {
        return 9;
      },
    });
    const row: ModelsDevModel = {
      id: "fixture-model",
      name: "Fixture Model",
      cost: cost as ModelsDevModel["cost"],
    };
    const model = mapModel(entry("fx/known"), {
      catalog: FIXTURE,
      enrichment: enrichment(row),
    });

    // Then only own data properties are read and the fallback is zero.
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
