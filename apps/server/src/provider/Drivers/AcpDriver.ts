/**
 * AcpDriver — instantiates the generic ACP adapter from settings.
 *
 * Deliberately thin. Vendor drivers beside this one carry probe commands,
 * version parsing and model-discovery calls specific to one product; this one
 * has none of that, because everything it needs is either in the protocol or in
 * configuration.
 *
 * That is also why its snapshot is static. There is no universal way to ask an
 * arbitrary binary "are you healthy and what models do you have" — the protocol
 * answers the second question at session start, and inventing a probe would
 * mean guessing at a CLI convention the agent may not follow.
 *
 * @module provider/Drivers/AcpDriver
 */
import {
  AcpSettings,
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeUnsupportedTextGeneration } from "../../textGeneration/UnsupportedTextGeneration.ts";
import { makeAcpAdapter, ACP_DRIVER_KIND } from "../Layers/AcpAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";

const decodeAcpSettings = Schema.decodeSync(AcpSettings);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Models an ACP agent offers, read from a file the user maintains.
 *
 * Entries may be `"id"` or `{ id, name }`. They are returned as built-in rather
 * than custom models because custom ones are stored under a normalized slug
 * that also becomes their label, which loses names like "Gemini 3.7 Flash".
 *
 * A file that is missing or malformed yields no models rather than failing the
 * provider: an unreadable list is a reason to show nothing, not a reason to be
 * unable to launch the agent.
 */
export const readModelsFile = Effect.fn("AcpDriver.readModelsFile")(function* (
  modelsPath: string,
  capabilities: ModelCapabilities,
) {
  if (modelsPath.trim().length === 0) return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = modelsPath.startsWith("~/")
    ? path.join(process.env.HOME ?? "", modelsPath.slice(2))
    : modelsPath;

  const parsed = yield* fs.readFileString(resolved).pipe(
    Effect.flatMap((raw) => decodeJson(raw)),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not read the ACP models file", { modelsPath: resolved, cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
  if (parsed === null) return [];

  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: ReadonlyArray<unknown> }).models
      : [];

  const models: Array<ServerProviderModel> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.trim().length === 0 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry === "string" ? entry : (entry as { name?: unknown }).name;
    models.push({
      slug: id,
      name: typeof name === "string" && name.trim().length > 0 ? name : id,
      isCustom: false,
      capabilities,
    });
  }
  return models;
});

const PRESENTATION = {
  displayName: "ACP agent",
  badgeLabel: "Generic",
  showInteractionModeToggle: false,
} as const;

/**
 * Options a user can change per turn, rendered by the client as pickers.
 *
 * These are decisions, not launch settings: anything that changes how the agent
 * process is started belongs to a provider instance instead, because it cannot
 * be applied to a session already running.
 *
 * The list is data. A new option is an entry here plus a case in the bridge —
 * no client work, and it renders on web, desktop and mobile alike.
 */
const ACP_OPTION_DESCRIPTORS: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "review",
    label: "Review",
    description: "Which tool calls stop for approval before they run.",
    type: "select",
    options: [
      {
        id: "review-everything",
        label: "Everything",
        description: "Approve every tool call. Safest, and the supervision posture.",
        isDefault: true,
      },
      {
        id: "review-consequential",
        label: "Consequential only",
        description: "Reads run freely; writes, commands and network stop for approval.",
      },
      {
        id: "allow-all",
        label: "Nothing",
        description: "Approve everything automatically. Only sensible when something else gates.",
      },
    ],
    currentValue: "review-everything",
  },
];

const ACP_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [...ACP_OPTION_DESCRIPTORS],
});

const UPDATE = makeStaticProviderMaintenanceResolver(
  // Updating an arbitrary third-party binary is not ours to manage.
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: ACP_DRIVER_KIND,
    packageName: null,
  }),
);

export type AcpDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path;

export const AcpDriver: ProviderDriver<AcpSettings, AcpDriverEnv> = {
  driverKind: ACP_DRIVER_KIND,
  metadata: {
    displayName: PRESENTATION.displayName,
    supportsMultipleInstances: true,
  },
  configSchema: AcpSettings,
  defaultConfig: (): AcpSettings => decodeAcpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: ACP_DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies AcpSettings;

      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.command,
        env: processEnv,
      });

      const adapter = yield* makeAcpAdapter(effectiveConfig, { instanceId });
      const fileModels = yield* readModelsFile(effectiveConfig.modelsPath, ACP_CAPABILITIES);

      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const configured = effectiveConfig.command.trim().length > 0;
      const draft = buildServerProvider({
        driver: ACP_DRIVER_KIND,
        presentation: {
          ...PRESENTATION,
          ...(displayName ? { displayName } : {}),
        },
        enabled,
        checkedAt,
        models: providerModelsFromSettings(
          fileModels,
          effectiveConfig.customModels,
          ACP_CAPABILITIES,
        ),
        probe: {
          // "Installed" here means "a command was configured". Claiming to have
          // verified a binary we never ran would be a lie the UI would repeat.
          installed: configured,
          version: null,
          status: configured ? "ready" : "error",
          auth: { status: "unknown" },
          ...(configured
            ? {}
            : { message: "Set the command for this ACP agent, then restart T3 Code." }),
        },
      });

      const snapshotValue: ServerProvider = {
        ...draft,
        instanceId,
        driver: ACP_DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      };
      const snapshotRef = yield* Ref.make(snapshotValue);

      return {
        instanceId,
        driverKind: ACP_DRIVER_KIND,
        continuationIdentity,
        displayName,
        ...(accentColor ? { accentColor } : {}),
        enabled,
        snapshot: {
          maintenanceCapabilities,
          getSnapshot: Ref.get(snapshotRef),
          refresh: Ref.get(snapshotRef),
          streamChanges: Stream.empty,
        },
        adapter,
        textGeneration: makeUnsupportedTextGeneration(PRESENTATION.displayName),
      } satisfies ProviderInstance;
    }),
};
