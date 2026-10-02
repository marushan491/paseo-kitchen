import { useCallback } from "react";
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
  section?: "overview" | "activity" | "problems";
  teamNavigation?: (teamId?: string) => void;
};

export function Dashboard(props: DashboardProps) {
  const styles = useDashboardStyles(props);
  const state = useDashboard(props);
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
              title="Teams"
              value={undefined}
              onAction={props.teamNavigation}
              variant="secondary"
            />
          ) : null}
        </View>
        <Text style={styles.muted}>
          {needsYou.length} needs you · {running} running · {problems.length} problems
        </Text>
      </View>
      {state.loading ? <Text style={styles.muted}>Loading agents and workspaces…</Text> : null}
      {section === "overview" && state.snapshot ? (
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
      {!state.snapshot ? (
        <Text style={styles.muted}>
          Configure Overview settings to load persistent inbox preferences.
        </Text>
      ) : null}
      {section !== "problems" && state.snapshot ? (
        <Board
          {...props}
          state={state}
          jiraSite={settings.status === "ready" ? settings.values.jiraSite : ""}
        />
      ) : null}
      <KitchenScheduleOverview {...props} section={section} onOpenTeam={props.teamNavigation} />
      {state.inventories
        .filter((host) => !state.snapshot?.scheduleHostIds.includes(host.serverId))
        .map((host) => (
          <Text key={host.serverId} style={styles.muted}>
            Schedule monitoring not configured for {host.label}. Add its explicit endpoint in
            Overview settings.
          </Text>
        ))}
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
