import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import { connectLegacyClient } from "./server/legacy-client.js";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isAbsolute } from "node:path";
import { factorySettings } from "./shared/preferences.js";
import { registerFactory } from "./server/register.js";

export default function contribute(server: PluginServerContext) {
  const host = server as PluginServerContext & { paseo?: PaseoApi; dataDirectory?: string };
  const settings = server.registerSettings(factorySettings);
  let concurrency = 4;
  const removeSettings = settings.subscribe((state) => {
    if (state.status === "ready") concurrency = state.values.maxConcurrentAgents;
  });
  const factory = registerFactory(server, {
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
    if (!disposed) await factory.initialize(api);
  })().catch((error: unknown) => {
    console.error("Kitchen startup failed", error);
  });
  return async () => {
    disposed = true;
    removeSettings();
    await factory.cleanup();
    await startup;
    await legacyClient?.close();
  };
}
