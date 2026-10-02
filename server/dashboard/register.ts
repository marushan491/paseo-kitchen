import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  dashboardPreference,
  dashboardSchedule,
  dashboardSettings,
  dashboardSnapshot,
} from "../../shared/dashboard/contracts.js";
import { PreferenceStore } from "./storage.js";

import { readSchedules, resolveScheduleTarget, scheduleControl } from "./schedules.js";

export function registerDashboard(server: PluginServerContext) {
  const settings = server.registerSettings(dashboardSettings);
  async function configured() {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error("Dashboard settings are invalid");
    return state.values;
  }
  async function preferences() {
    const values = await configured();
    const runtimeDirectory = (server as PluginServerContext & { dataDirectory?: string })
      .dataDirectory;
    const directory =
      values.dataDirectory ||
      (runtimeDirectory ? join(runtimeDirectory, "dashboard") : "") ||
      (values.daemonHome ? join(values.daemonHome, "plugin-data", "pandaos-dashboard") : "");
    if (!directory)
      throw new Error(
        "Configure a separate dashboard data directory or this host's daemon home in plugin settings",
      );
    return new PreferenceStore(directory);
  }
  let writes: Promise<unknown> = Promise.resolve();
  server.handle(dashboardSnapshot, async (input) => {
    const values = await configured();
    const scheduleTargets: ({ kind: "local" } | { kind: "remote"; serverId: string })[] =
      input.kitchenOnly
        ? []
        : [
            { kind: "local" },
            ...[...new Set(values.scheduleHosts.map((host) => host.serverId))].map((serverId) => ({
              kind: "remote" as const,
              serverId,
            })),
          ];
    const scheduleErrors: { target: (typeof scheduleTargets)[number]; message: string }[] = [];
    const results = await Promise.all(
      scheduleTargets.map(async (target) => {
        try {
          const schedules = await readSchedules(resolveScheduleTarget(values, target));
          return schedules.map((schedule) => ({ target, schedule }));
        } catch (error) {
          scheduleErrors.push({
            target,
            message: error instanceof Error ? error.message : "Schedule outcomes unavailable",
          });
          return [];
        }
      }),
    );
    await writes.catch(() => undefined);
    return {
      preferences: await (await preferences()).read(),
      schedules: results.flat(),
      scheduleErrors,
      scheduleTargets,
    };
  });
  server.handle(dashboardPreference, async (input) => {
    const store = await preferences();
    const change = (current: import("./storage.js").Preferences) => {
      if (input.action === "import")
        return {
          snoozedUntil: { ...current.snoozedUntil, ...input.preferences.snoozedUntil },
          doneAt: { ...current.doneAt, ...input.preferences.doneAt },
        };
      if (input.action === "done")
        return {
          ...current,
          doneAt: {
            ...current.doneAt,
            [input.workspaceKey]: input.done ? new Date().toISOString() : null,
          },
        };
      const snoozedUntil = Object.fromEntries(
        Object.entries(current.snoozedUntil).filter(([, until]) => until > Date.now()),
      );
      return { ...current, snoozedUntil: { ...snoozedUntil, [input.itemId]: input.untilMs } };
    };
    const operation = writes.catch(() => undefined).then(() => store.update(change));
    writes = operation;
    return operation;
  });
  server.handle(dashboardSchedule, async (input) => {
    const values = await configured();
    await scheduleControl(resolveScheduleTarget(values, input.target), input.id, input.action);
    return { accepted: true as const };
  });
  return async () => {
    await writes;
  };
}
