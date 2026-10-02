import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { dashboardSettings } from "../../shared/dashboard/contracts.js";
import { KitchenScheduleOverview } from "./kitchen-schedules.js";
import { Board } from "./board.js";
import { InboxCard } from "./inbox.js";
import { type DashboardState, useDashboard } from "./state.js";
import { Action, useDashboardStyles } from "./ui.js";
import { partitionInbox } from "../../shared/dashboard/overview.js";

export type DashboardProps = PluginSurfaceProps & {
  projectPath?: string;
  section?: "overview" | "activity" | "problems";
  teamNavigation?: (teamId?: string) => void;
};

export function Dashboard(props: DashboardProps) {
  const styles = useDashboardStyles(props);
  const allState = useDashboard(props);
  const state = useMemo(() => {
    const sessions = allState.sessions.filter(
      (session) =>
        !props.projectPath ||
        (session.serverId === props.host.id && session.projectRootPath === props.projectPath),
    );
    const sessionKeys = new Set(sessions.map((session) => session.key));
    const projectKeys = new Set(sessions.map((session) => session.projectViewKey));
    const schedules = allState.schedules.filter(
      (entry) => !props.projectPath || projectKeys.has(entry.projectViewKey || ""),
    );
    return {
      ...allState,
      sessions,
      schedules,
      inbox: {
        ...allState.inbox,
        items: allState.inbox.items.filter(
          (item) =>
            !props.projectPath ||
            ("sessionKey" in item
              ? sessionKeys.has(item.sessionKey)
              : schedules.some(
                  (entry) =>
                    entry.serverId === item.serverId && entry.schedule.id === item.scheduleId,
                )),
        ),
      },
    };
  }, [allState, props.projectPath, props.host.id]);
  const settings = useSettings(dashboardSettings);
  const refresh = useCallback(() => {
    void state.refresh();
  }, [state]);
  const running = state.sessions.reduce(
    (count, session) => count + session.agents.filter((agent) => agent.bucket === "running").length,
    0,
  );
  const { needsYou, problems } = partitionInbox(state.inbox.items);
  const section = props.section ?? "overview";
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.stack}>
        <View style={styles.row}>
          <Text style={styles.title}>
            {{ overview: "Overview", activity: "Activity", problems: "Problems" }[section]}
          </Text>
          <Action theme={props.theme} title="Refresh" value={null} onAction={refresh} />
          {props.teamNavigation ? (
            <Action
              theme={props.theme}
              title="Open missions"
              value={undefined}
              onAction={props.teamNavigation}
              variant="secondary"
            />
          ) : null}
        </View>
        <Text style={styles.muted}>
          {needsYou.length} need attention · {running} working · {problems.length} problems
        </Text>
      </View>
      <Text style={styles.muted}>
        {
          {
            overview:
              "Answer questions and review handoffs. Kitchen keeps working when no decision is needed.",
            activity: "Live workspaces and planned runs for your selected project scope.",
            problems: "Failed runs and blocked checks, with links to the affected work.",
          }[section]
        }
      </Text>
      {state.loading ? <Text style={styles.muted}>Loading agents and workspaces…</Text> : null}
      {section === "overview" ? (
        <View style={styles.stack}>
          <Text style={styles.heading}>Needs you · {needsYou.length}</Text>
          {state.inbox.snoozedCount ? (
            <Text style={styles.muted}>
              {state.inbox.snoozedCount} snoozed until their wake time
            </Text>
          ) : null}
          {needsYou.map((item) => (
            <InboxCard key={item.id} {...props} item={item} state={state} />
          ))}
          {!needsYou.length && !state.loading ? (
            <Text style={styles.muted}>Nothing needs your attention.</Text>
          ) : null}
        </View>
      ) : null}
      {section !== "activity" ? (
        <Problems {...props} state={state} always={section === "problems"} />
      ) : null}
      {!state.snapshot && state.error ? (
        <Text style={styles.muted}>
          Dashboard preferences are unavailable. Open Settings → Dashboard to configure storage.
        </Text>
      ) : null}
      {section === "activity" && state.snapshot ? (
        <Board
          {...props}
          state={state}
          jiraSite={settings.status === "ready" ? settings.values.jiraSite : ""}
        />
      ) : null}
      {section !== "overview" ? (
        <KitchenScheduleOverview
          {...props}
          projectPath={props.projectPath}
          section={section}
          onOpenTeam={props.teamNavigation}
        />
      ) : null}
      {section === "activity"
        ? state.inventories
            .filter((host) => !state.snapshot?.scheduleHostIds.includes(host.serverId))
            .map((host) => (
              <Text key={host.serverId} style={styles.muted}>
                Schedule monitoring not configured for {host.label}. Add its explicit endpoint in
                Overview settings.
              </Text>
            ))
        : null}
    </ScrollView>
  );
}

function Problems(props: DashboardProps & { state: DashboardState; always: boolean }) {
  const styles = useDashboardStyles(props);
  const { state } = props;
  const { problems } = partitionInbox(state.inbox.items);
  const directoryProblems = state.inventories.filter((host) => host.error || !host.complete);
  const scheduleProblems = Object.entries(state.snapshot?.scheduleErrors ?? {});
  const count =
    problems.length + directoryProblems.length + scheduleProblems.length + (state.error ? 1 : 0);
  if (!count && !props.always) return null;
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Problems · {count}</Text>
      {state.error ? <Text style={styles.danger}>{state.error}</Text> : null}
      {directoryProblems.map((host) => (
        <Text key={host.serverId} style={styles.danger}>
          {host.error || `${host.label}: directory exceeds 2,000 entries; overview is partial`}
        </Text>
      ))}
      {scheduleProblems.map(([serverId, message]) => (
        <Text key={serverId} style={styles.danger}>
          Schedule outcomes unavailable on{" "}
          {state.inventories.find((host) => host.serverId === serverId)?.label || serverId}:{" "}
          {message}
        </Text>
      ))}
      {problems.map((item) => (
        <InboxCard key={item.id} {...props} item={item} state={state} />
      ))}
      {!count ? <Text style={styles.muted}>No reported errors.</Text> : null}
    </View>
  );
}
