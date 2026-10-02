import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { factoryList } from "../../shared/factory-contracts.js";
import { kitchenAgentIds } from "../../shared/dashboard/kitchen-scope.js";
import { kitchenCompletionByWorkspace } from "../../shared/dashboard/completion-model.js";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { dashboardPreference, dashboardSnapshot } from "../../shared/dashboard/contracts.js";
import {
  buildLeitstandInbox,
  snoozeUntil,
  type SnoozeOption,
} from "../../shared/dashboard/inbox-model.js";
import { resolveScheduleProject } from "../../shared/dashboard/session-model.js";
import type { z } from "zod";
import { useDirectory, useSessions } from "./directory.js";

type WireSnapshot = z.infer<typeof dashboardSnapshot.output>;
type Snapshot = Omit<WireSnapshot, "schedules" | "scheduleErrors"> & {
  schedules: {
    serverId: string;
    target: WireSnapshot["scheduleTargets"][number];
    schedule: WireSnapshot["schedules"][number]["schedule"];
  }[];
  scheduleErrors: Record<string, string>;
  scheduleHostIds: string[];
};
function bindSnapshot(next: WireSnapshot, ownId: string): Snapshot {
  const serverId = (target: WireSnapshot["scheduleTargets"][number]) =>
    target.kind === "local" ? ownId : target.serverId;
  return {
    ...next,
    schedules: next.schedules.map((entry) => ({ ...entry, serverId: serverId(entry.target) })),
    scheduleErrors: Object.fromEntries(
      next.scheduleErrors.map((entry) => [serverId(entry.target), entry.message]),
    ),
    scheduleHostIds: next.scheduleTargets.map(serverId),
  };
}
const EMPTY_PREFERENCES = { snoozedUntil: {}, doneAt: {} };

export function useDashboard(props: PluginSurfaceProps) {
  const read = useRpc(dashboardSnapshot);
  const write = useRpc(dashboardPreference);
  const listTeams = useRpc(factoryList);
  const teams = useQuery({
    queryKey: ["factory", "teams"],
    queryFn: () => listTeams({}),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now);
  const memberIds = useMemo(() => kitchenAgentIds(teams.data?.teams ?? []), [teams.data]);
  const directory = useDirectory(props, memberIds, teams.isSuccess);
  const preferenceRevision = useRef(0);
  const refresh = useCallback(async () => {
    try {
      const revision = preferenceRevision.current;
      const next = await read({ kitchenOnly: true });
      setSnapshot((current) => ({
        ...bindSnapshot(next, props.host.id),
        preferences:
          revision !== preferenceRevision.current && current
            ? current.preferences
            : next.preferences,
      }));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Dashboard could not load");
    }
  }, [read, props.host.id]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    async function tick() {
      if (pending || disposed) return;
      pending = true;
      try {
        const revision = preferenceRevision.current;
        const next = await read({ kitchenOnly: true });
        if (!disposed) {
          setSnapshot((current) => ({
            ...bindSnapshot(next, props.host.id),
            preferences:
              revision !== preferenceRevision.current && current
                ? current.preferences
                : next.preferences,
          }));
          setError(null);
          setNowMs(Date.now());
        }
      } catch (failure) {
        if (!disposed)
          setError(failure instanceof Error ? failure.message : "Dashboard could not load");
      } finally {
        pending = false;
      }
    }
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [read, props.host.id]);
  const preferences = snapshot?.preferences ?? EMPTY_PREFERENCES;
  const kitchenCompletions = useMemo(() => {
    const own = directory.inventories.find((inventory) => inventory.serverId === props.host.id);
    return kitchenCompletionByWorkspace(teams.data?.teams || [], own?.agents || [], props.host.id);
  }, [teams.data, directory.inventories, props.host.id]);
  const effectivePreferences = useMemo(
    () => ({ ...preferences, doneAt: { ...kitchenCompletions, ...preferences.doneAt } }),
    [preferences, kitchenCompletions],
  );
  const sessions = useSessions(directory.inventories, effectivePreferences);
  const activeMemberIds = useMemo(
    () =>
      new Set(
        kitchenAgentIds(
          (teams.data?.teams ?? []).filter(
            (state) => !["done", "canceled"].includes(state.team.status),
          ),
        ),
      ),
    [teams.data],
  );
  const schedules = useMemo(
    () =>
      (snapshot?.schedules ?? [])
        .filter(
          ({ schedule }) =>
            schedule.target.type === "agent" && memberIds.includes(schedule.target.agentId),
        )
        .map(({ serverId, target, schedule }) =>
          Object.assign(
            {
              key: `${serverId}:${schedule.id}`,
              serverId,
              target,
              schedule,
            },
            resolveScheduleProject({ serverId, schedule }, sessions),
          ),
        ),
    [snapshot, sessions, memberIds],
  );
  const inbox = useMemo(
    () =>
      buildLeitstandInbox({
        sessions: sessions.map((session) => ({
          ...session,
          agents: session.agents.filter((agent) => activeMemberIds.has(agent.id)),
        })),
        schedules,
        snoozedUntil: preferences.snoozedUntil,
        nowMs,
        kitchenOnly: true,
      }),
    [sessions, schedules, preferences, nowMs, activeMemberIds],
  );
  useEffect(() => {
    if (inbox.nextWakeAt === null) return;
    const timer = setTimeout(
      () => setNowMs(Date.now()),
      Math.min(2_147_483_647, Math.max(0, inbox.nextWakeAt! - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [inbox.nextWakeAt]);
  const snooze = useCallback(
    async (itemId: string, option: SnoozeOption) => {
      const next = await write({
        action: "snooze",
        itemId,
        untilMs: snoozeUntil(option, new Date()).getTime(),
      });
      preferenceRevision.current += 1;
      setSnapshot((current) => (current ? { ...current, preferences: next } : current));
      setNowMs(Date.now());
    },
    [write],
  );
  const markDone = useCallback(
    async (workspaceKey: string, done: boolean) => {
      const next = await write({ action: "done", workspaceKey, done });
      preferenceRevision.current += 1;
      setSnapshot((current) => (current ? { ...current, preferences: next } : current));
    },
    [write],
  );
  return {
    ...directory,
    sessions,
    kitchenCompletions,
    schedules,
    inbox,
    snapshot,
    error: error ?? (teams.error ? String(teams.error) : null),
    refresh,
    snooze,
    markDone,
  };
}

export type DashboardState = ReturnType<typeof useDashboard>;
