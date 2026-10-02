import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { dashboardSettings } from "../../shared/dashboard/contracts.js";
import { KitchenScheduleOverview } from "./kitchen-schedules.js";
import { Board } from "./board.js";
import { InboxCard } from "./inbox.js";
import { type DashboardState, useDashboard } from "./state.js";
import { Action, useDashboardStyles } from "./ui.js";
import { factoryPacks, type TeamState } from "../../shared/factory-contracts.js";
import { kitchenHumanRequests } from "../../shared/dashboard/kitchen-scope.js";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { partitionInbox } from "../../shared/dashboard/overview.js";
import { MissionSummaryRow } from "../mission-summary.js";
import {
  missionSummary,
  missionWorkflowFor,
  type MissionPack,
} from "../../shared/mission-stage.js";

export type DashboardProps = PluginSurfaceProps & {
  projectPath?: string;
  section?: "overview" | "activity" | "problems";
  teamNavigation?: (teamId?: string) => void;
};

export function Dashboard(props: DashboardProps) {
  const styles = useDashboardStyles(props);
  const allState = useDashboard(props);
  const readPacks = useRpc(factoryPacks);
  const packs = useQuery({ queryKey: ["factory", "packs"], queryFn: () => readPacks({}) });
  const availablePacks = packs.data?.packs ?? EMPTY_PACKS;
  const requests = useMemo(
    () =>
      kitchenHumanRequests(allState.teams, props.projectPath).filter(
        (request) =>
          (allState.snapshot?.preferences.snoozedUntil[request.id] ?? 0) <= allState.nowMs,
      ),
    [allState.teams, props.projectPath, allState.snapshot, allState.nowMs],
  );
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
  const { needsYou } = partitionInbox(state.inbox.items);
  const missions = useMemo(
    () =>
      allState.teams.filter(
        (mission) =>
          !props.projectPath ||
          mission.team.cwd === props.projectPath ||
          mission.team.cwd.startsWith(props.projectPath + "/"),
      ),
    [allState.teams, props.projectPath],
  );
  const active = useMemo(
    () => missions.filter((mission) => !["done", "canceled"].includes(mission.team.status)),
    [missions],
  );
  const completed = useMemo(
    () =>
      missions
        .filter((mission) => mission.team.status === "done")
        .sort((left, right) =>
          missionSummary(right, undefined).updatedAt.localeCompare(
            missionSummary(left, undefined).updatedAt,
          ),
        ),
    [missions],
  );
  const missionProblems = useMemo(
    () =>
      active.filter(
        (mission) =>
          missionSummary(mission, missionWorkflowFor(mission, availablePacks), allState.agents)
            .problem,
      ),
    [active, availablePacks, allState.agents],
  );
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
      </View>
      <Text style={styles.muted}>
        {
          {
            overview: "See what needs your decision, what Kitchen is doing and what is ready.",
            activity: "Live workspaces and planned runs for your selected project scope.",
            problems: "Failed runs and blocked checks, with links to the affected work.",
          }[section]
        }
      </Text>
      {state.loading || state.teamsLoading ? (
        <Text style={styles.muted}>Loading Kitchen missions…</Text>
      ) : null}
      {section === "overview" ? (
        <NeedsYou {...props} state={state} items={needsYou} requests={requests} />
      ) : null}
      {section === "overview" ? (
        <MissionGroup
          {...props}
          title="Active missions"
          missions={active}
          packs={availablePacks}
          state={state}
        />
      ) : null}
      {section !== "activity" ? (
        <Problems
          {...props}
          state={state}
          always={section === "problems"}
          missions={missionProblems}
          packs={availablePacks}
        />
      ) : null}
      {section === "overview" && completed.length ? (
        <MissionGroup
          {...props}
          title="Recently completed"
          missions={completed}
          packs={availablePacks}
          state={state}
        />
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
      {section !== "problems" ? (
        <View style={styles.stack}>
          <Text style={styles.heading}>Scheduled</Text>
          <KitchenScheduleOverview
            {...props}
            projectPath={props.projectPath}
            section={section}
            onOpenTeam={props.teamNavigation}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const EMPTY_PACKS: readonly MissionPack[] = [];
function NeedsYou(
  props: DashboardProps & {
    state: DashboardState;
    items: ReturnType<typeof partitionInbox>["needsYou"];
    requests: ReturnType<typeof kitchenHumanRequests>;
  },
) {
  const styles = useDashboardStyles(props);
  const { teamNavigation } = props;
  const { snooze } = props.state;
  const openMission = useCallback((id: string) => teamNavigation?.(id), [teamNavigation]);
  const snoozeMission = useCallback(
    (id: string) => {
      void snooze(id, "hour");
    },
    [snooze],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>
        {props.items.length + props.requests.length
          ? `Needs you (${props.items.length + props.requests.length})`
          : "You’re clear"}
      </Text>
      {props.state.inbox.snoozedCount ? (
        <Text style={styles.muted}>
          {props.state.inbox.snoozedCount} snoozed until their wake time
        </Text>
      ) : null}
      {props.requests.map(({ state: mission, item, id, ready, reason }) => (
        <View key={id} style={styles.card}>
          <Text style={styles.heading}>
            {ready ? "Ready for acceptance" : "Question"} · {mission.team.title}
          </Text>
          {item.id !== mission.team.rootItemId ? (
            <Text style={styles.muted}>{item.title}</Text>
          ) : null}
          <Text style={styles.text}>{reason}</Text>
          <View style={styles.row}>
            <Action
              theme={props.theme}
              title={ready ? "Review result" : "Open mission and reply"}
              value={mission.team.id}
              onAction={openMission}
              variant="primary"
              disabled={!props.teamNavigation}
            />
            <Action
              theme={props.theme}
              title="Snooze one hour"
              value={id}
              onAction={snoozeMission}
            />
          </View>
        </View>
      ))}
      {props.items.map((item) => (
        <InboxCard key={item.id} {...props} item={item} state={props.state} />
      ))}
      {!props.items.length && !props.requests.length && !props.state.loading ? (
        <Text style={styles.muted}>Kitchen will bring decisions here when it needs you.</Text>
      ) : null}
    </View>
  );
}

function MissionGroup(
  props: DashboardProps & {
    title: string;
    missions: TeamState[];
    packs: readonly MissionPack[];
    state: DashboardState;
  },
) {
  const styles = useDashboardStyles(props);
  const { teamNavigation } = props;
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Text style={styles.heading}>
          {props.title}
          {props.missions.length ? ` (${props.missions.length})` : ""}
        </Text>
        {teamNavigation && props.missions.length > 5 ? (
          <Action
            theme={props.theme}
            title="View all"
            value={undefined}
            onAction={teamNavigation}
          />
        ) : null}
      </View>
      {props.missions.slice(0, 5).map((mission) => (
        <MissionSummaryRow
          key={mission.team.id}
          {...props}
          state={mission}
          agents={props.state.agents}
          workflow={missionWorkflowFor(mission, props.packs)}
          onOpen={teamNavigation}
        />
      ))}
      {!props.missions.length && !props.state.teamsLoading ? (
        <Text style={styles.muted}>
          Start with an outcome. Kitchen will plan the work, assign agents and verify the result.
        </Text>
      ) : null}
    </View>
  );
}

function Problems(
  props: DashboardProps & {
    state: DashboardState;
    always: boolean;
    missions: TeamState[];
    packs: readonly MissionPack[];
  },
) {
  const styles = useDashboardStyles(props);
  const { state } = props;
  const { problems } = partitionInbox(state.inbox.items);
  const directoryProblems = state.inventories.filter((host) => host.error || !host.complete);
  const scheduleProblems = Object.entries(state.snapshot?.scheduleErrors ?? {});
  const count =
    problems.length +
    directoryProblems.length +
    scheduleProblems.length +
    props.missions.length +
    (state.error ? 1 : 0);
  if (!count && !props.always) return null;
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Problems · {count}</Text>
      {state.error ? <Text style={styles.danger}>{state.error}</Text> : null}
      {directoryProblems.map((host) => (
        <Text key={host.serverId} style={styles.danger}>
          {host.error || `${host.label}: some Kitchen agents could not be observed`}
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
      {props.missions.map((mission) => (
        <View key={mission.team.id} style={styles.stack}>
          <MissionSummaryRow
            {...props}
            state={mission}
            workflow={missionWorkflowFor(mission, props.packs)}
            agents={state.agents}
            onOpen={props.teamNavigation}
          />
          <Text style={styles.danger}>
            {
              missionSummary(mission, missionWorkflowFor(mission, props.packs), state.agents)
                .problem
            }
          </Text>
        </View>
      ))}
      {!count ? <Text style={styles.muted}>No reported errors.</Text> : null}
    </View>
  );
}
