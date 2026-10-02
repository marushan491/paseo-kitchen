import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import { connectLegacyClient } from "./server/legacy-client.js";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isAbsolute } from "node:path";
import { factorySettings } from "./shared/preferences.js";
import { registerDashboard } from "./server/dashboard/register.js";
import { registerFactory } from "./server/register.js";
import { registerMigration } from "./server/migration.js";
import { registerImprovements } from "./server/improvements.js";
import {
  KitchenSystemOne,
  hostSystemOneConfig,
  hostSystemOneCredentials,
} from "./server/system-one.js";
import { loadKitchenRuntimeConfig, readOperatorCredential } from "./server/runtime-config.js";
import { registerKitchenSuggestions } from "./server/kitchen-suggestion.js";

export default function contribute(server: PluginServerContext) {
  const host = server as PluginServerContext & { paseo?: PaseoApi; dataDirectory?: string };
  const settings = server.registerSettings(factorySettings);
  const storageDirectory = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    const directory = state.values.dataDirectory.trim() || host.dataDirectory;
    if (!directory || !isAbsolute(directory))
      throw new Error("Configure an absolute Kitchen storage directory");
    return directory;
  };
  const removeDashboard = registerDashboard(server);
  let concurrency = 4;
  const removeSettings = settings.subscribe((state) => {
    if (state.status === "ready") concurrency = state.values.maxConcurrentAgents;
  });
  const systemOneConfig = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(state.error);
    return hostSystemOneConfig(state.values.daemonHome.trim() || undefined);
  };
  const decisionSource = new KitchenSystemOne({
    config: systemOneConfig,
    credentials: async () => {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      return hostSystemOneCredentials(state.values.daemonHome.trim() || undefined);
    },
  });
  const factory = registerFactory(server, {
    decisionSource,
    operatorCredential: async () =>
      process.env.KITCHEN_OPERATOR_CREDENTIAL || readOperatorCredential(await storageDirectory()),
    runtimeConfig: loadKitchenRuntimeConfig,
    publicationCli: process.env.KITCHEN_PUBLICATION_CLI
      ? { executable: process.env.KITCHEN_PUBLICATION_CLI }
      : undefined,
    storageRoot: async () => {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      concurrency = state.values.maxConcurrentAgents;
      const directory = state.values.dataDirectory.trim() || host.dataDirectory;
      if (!directory || !isAbsolute(directory)) {
        throw new Error(
          "Set an absolute data directory in Agent Factory settings, then reload the plugin.",
        );
      }
      return directory;
    },
    maxConcurrentAgents: () => concurrency,
    hostControl: async () => {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      return {
        daemonHost: state.values.daemonHost.trim() || undefined,
        daemonHome: state.values.daemonHome.trim() || undefined,
        executable: state.values.cliExecutable.trim(),
        argv: state.values.cliArguments,
      };
    },
    packDirectory: async () => {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      const directory = state.values.packDirectory.trim();
      if (directory && !isAbsolute(directory))
        throw new Error("Workflow pack directory must be absolute");
      return directory || undefined;
    },
  });
  registerMigration(server, {
    home: async () => {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      const home = state.values.daemonHome.trim();
      if (!home)
        throw new Error("Native migration requires the explicitly configured local daemon home");
      return home;
    },
    storageRoot: storageDirectory,
    service: factory.getService,
  });
  const improvements = registerImprovements(server, {
    storageRoot: storageDirectory,
    service: factory.getService,
  });
  const removeSuggestions = registerKitchenSuggestions(server, {
    config: systemOneConfig,
    decisionSource,
    service: factory.getService,
  });
  let disposed = false;
  let legacyClient: PaseoClient | undefined;
  const startup = (async () => {
    let api = host.paseo;
    if (!api) {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      const daemonHost = state.values.daemonHost.trim() || undefined;
      const client = await connectLegacyClient({
        daemonHost,
        daemonHome:
          state.values.daemonHome.trim() || (daemonHost ? undefined : process.env.PASEO_HOME),
        executable: state.values.cliExecutable.trim(),
        argv: state.values.cliArguments,
      });
      if (disposed) {
        await client.close();
        return;
      }
      legacyClient = client;
      api = client;
    }
    if (!disposed) {
      await factory.initialize(api);
      await improvements.initialize(api);
    }
  })().catch((error: unknown) => {
    console.error("Kitchen startup failed", error);
  });
  return async () => {
    disposed = true;
    removeSuggestions();
    removeSettings();
    await removeDashboard();
    await improvements.cleanup();
    await factory.cleanup();
    await startup;
    await legacyClient?.close();
  };
}
