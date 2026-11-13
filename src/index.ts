// allow: SIZE_OK - plan task 7 pins the single extension entry at src/index.ts.
/**
 * Native OMP extension entry for the 9Router provider.
 *
 * Startup contract:
 * 1. `registerProvider("9router", {})` runs synchronously first. It is the
 *    provider-owning marker: the host treats this extension as eager even when
 *    configuration or discovery later fails.
 * 2. The connection is read from `models.yml`, discovery runs against the live
 *    router, and the roster is mapped once.
 * 3. Exactly one final roster is registered, carrying the raw `apiKey`
 *    reference from models.yml. The resolved secret is used for discovery only.
 *
 * Every expected failure resolves the factory instead of throwing: the host
 * rolls back queued provider registrations when a factory rejects, which would
 * drop the ownership marker. Failures are queued as one redacted diagnostic and
 * delivered on `session_start` (UI notice when available, stderr otherwise).
 *
 * Reload scope: the startup contract covers one process start. The public
 * extension API exposes no in-process reload of a factory, and a changed server
 * roster is only picked up by the next OMP process. Overlay removal belongs to
 * the host: an extension-source unregistration clears every provider that
 * source registered (proven against 18.20.0 in task-7 evidence).
 */
import type {
  ExtensionFactory,
  ProviderConfig,
  ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";
import { readNineRouterConnection } from "./config.js";
import {
  type DiscoverModelsOptions,
  type DiscoveryFailure,
  type DiscoveryResult,
  discoverModels,
} from "./discovery.js";
import { mapModels, type OmpModelConfig } from "./model-mapper.js";
import { createModelsDevClient, type ModelsDevClient } from "./models-dev.js";

export const NINE_ROUTER_PROVIDER_ID = "9router" as const;

const PROVIDER_LABEL = "9Router";
const DEFAULT_API = "openai-completions" as const;

/** The only host surface the factory touches. */
export interface NineRouterExtensionContext {
  readonly hasUI: boolean;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface NineRouterExtensionApi {
  registerProvider(name: string, config: ProviderConfig): void;
  on(
    event: "session_start",
    handler: (
      event: { readonly type: "session_start" },
      ctx: NineRouterExtensionContext,
    ) => void | Promise<void>,
  ): void;
}

/**
 * The factory as this extension declares it: it only ever calls these two host
 * members. `ExtensionAPI` is structurally wider, so this signature remains
 * assignable to `ExtensionFactory` (checked on the default export below).
 */
export type NineRouterExtension = (pi: NineRouterExtensionApi) => Promise<void>;

/** Test seams. Omitted entries use the production path. */
export interface NineRouterExtensionDeps {
  /** Defaults to the active host agent directory. */
  readonly readConnection?: typeof readNineRouterConnection;
  /** Defaults to the bounded live discovery client. */
  readonly discover?: (
    options: DiscoverModelsOptions,
  ) => Promise<DiscoveryResult>;
  /** Defaults to the cached models.dev client. */
  readonly modelsDev?: ModelsDevClient;
}

interface StartupDiagnostics {
  add(message: string): void;
  deliver(ctx: NineRouterExtensionContext): void;
}

function createDiagnostics(): StartupDiagnostics {
  const messages: string[] = [];
  let delivered = false;
  return {
    add(message) {
      if (!messages.includes(message)) messages.push(message);
    },
    deliver(ctx) {
      if (delivered) return;
      delivered = true;
      for (const message of messages) {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else process.stderr.write(`${message}\n`);
      }
    },
  };
}

const failureReason = (failure: DiscoveryFailure): string =>
  failure.status === undefined
    ? failure.category
    : `${failure.category} (HTTP ${failure.status})`;

/**
 * Rejects a mapped model the host would refuse later. Registry validation runs
 * after the factory returns, outside this factory's try/catch, so the roster is
 * validated before it enters the registration queue.
 */
function isValidModel(model: OmpModelConfig): boolean {
  const cost = model.cost;
  return (
    typeof model.id === "string" &&
    model.id.length > 0 &&
    model.id.length <= 512 &&
    typeof model.name === "string" &&
    model.name.length > 0 &&
    model.api === DEFAULT_API &&
    typeof model.reasoning === "boolean" &&
    typeof model.supportsTools === "boolean" &&
    Array.isArray(model.input) &&
    model.input.length > 0 &&
    model.input.every((input) => input === "text" || input === "image") &&
    Number.isSafeInteger(model.contextWindow) &&
    model.contextWindow > 0 &&
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens > 0 &&
    typeof cost === "object" &&
    cost !== null &&
    [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  );
}

function validRoster(models: readonly OmpModelConfig[]): OmpModelConfig[] {
  return models.filter(isValidModel);
}

/**
 * Builds the extension factory. Dependencies exist for tests only; production
 * uses the host agent directory, live discovery, and the cached metadata client.
 */
export function createNineRouterExtension(
  deps: NineRouterExtensionDeps = {},
): NineRouterExtension {
  const readConnection = deps.readConnection ?? readNineRouterConnection;
  const discover = deps.discover ?? discoverModels;
  const modelsDev = deps.modelsDev ?? createModelsDevClient();

  return async (pi) => {
    // Eager provider-owning marker: registered before any await so the host
    // never marks this extension deferrable, whatever happens next.
    pi.registerProvider(NINE_ROUTER_PROVIDER_ID, {});
    const diagnostics = createDiagnostics();
    pi.on("session_start", (_event, ctx) => {
      diagnostics.deliver(ctx);
    });

    // No roster has been queued before the single final registration below, so
    // a failure needs no rollback of its own: the eager marker is the only
    // registration this extension has made.
    const fail = (message: string): void => {
      diagnostics.add(`${PROVIDER_LABEL}: ${message}`);
    };

    try {
      let connection: Awaited<ReturnType<typeof readConnection>>;
      try {
        connection = await readConnection();
      } catch {
        fail("configuration could not be read.");
        return;
      }
      if (!connection.ok) {
        fail(connection.error.message);
        return;
      }

      let discovery: DiscoveryResult;
      try {
        discovery = await discover({
          baseUrl: connection.connection.baseUrl,
          apiKey: connection.connection.resolvedApiKey,
        });
      } catch {
        fail("discovery failed (network).");
        return;
      }
      if (!discovery.ok) {
        fail(`discovery failed (${failureReason(discovery)}).`);
        return;
      }

      // `mapModels` treats an enrichment failure as an empty lookup for that
      // model only, so metadata never removes it from the roster.
      const mapped = await mapModels(discovery.entries, { lookup: modelsDev });

      const models = validRoster(mapped);
      const dropped = mapped.length - models.length;
      if (models.length === 0) {
        // One message covers both shapes: an empty roster and an all-invalid
        // one. Reporting the drop count separately would double-report.
        fail(
          dropped === 0
            ? "discovery returned no usable models."
            : `all ${dropped} discovered model(s) were invalid.`,
        );
        return;
      }
      if (dropped > 0)
        diagnostics.add(
          `${PROVIDER_LABEL}: dropped ${dropped} invalid model(s) before registration.`,
        );

      const roster: ProviderConfig = {
        baseUrl: connection.connection.baseUrl,
        // Raw models.yml value: the host performs native env resolution for
        // requests. The resolved secret never becomes host configuration.
        apiKey: connection.connection.apiKeyConfig,
        api: DEFAULT_API,
        models: models satisfies ProviderModelConfig[],
      };
      pi.registerProvider(NINE_ROUTER_PROVIDER_ID, roster);
    } catch {
      // Last resort: the host rolls back queued registrations when a factory
      // rejects, which would drop the ownership marker. Undiagnosed throws are
      // reported without their message so no secret can reach the UI.
      fail("startup failed unexpectedly.");
    }
  };
}

const extension: ExtensionFactory = createNineRouterExtension();
export default extension;
