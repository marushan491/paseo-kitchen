import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  factoryScheduleList,
  type KitchenSchedule,
  type TeamState,
} from "../shared/factory-contracts.js";
import {
  filterMissions,
  missionAge,
  missionSummary,
  missionWorkflowFor,
  type MissionAgents,
  type MissionFilter,
  type MissionPack,
  type MissionStage,
  type MissionStageStatus,
  type MissionWorkflow,
} from "../shared/mission-stage.js";
import { Action } from "./ui.js";

const noAgents: MissionAgents = {};
const filters = [
  { id: "active", title: "Active" },
  { id: "needs-you", title: "Needs you" },
  { id: "completed", title: "Completed" },
  { id: "scheduled", title: "Scheduled" },
  { id: "all", title: "All" },
] as const;
export const missionStageLabels: Record<MissionStageStatus, string> = {
  waiting: "Waiting",
  queued: "Queued",
  working: "Working",
  completed: "Completed",
  "needs-you": "Needs you",
  problem: "Blocked",
  unobserved: "Activity unavailable",
};

export function missionStageColor(theme: PluginSurfaceProps["theme"], status: MissionStageStatus) {
  if (status === "completed") return theme.colors.statusSuccess;
  if (status === "working") return theme.colors.accent;
  if (status === "needs-you") return theme.colors.statusWarning;
  if (status === "problem") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function useSummaryStyles({ theme, layout }: PluginSurfaceProps) {
  return useMemo(
    () => ({
      stack: { gap: 12 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 10,
      },
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, gap: 10 },
      footer: {
        paddingHorizontal: 16,
        paddingBottom: 10,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      metadata: { flex: 1, flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12 },
      title: { flex: 1, color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      caption: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
      heading: { color: theme.colors.foreground, fontSize: 17, fontWeight: "600" as const },
      pill: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      rail: { flexDirection: "row" as const, gap: 4, paddingVertical: 4 },
      step: { minWidth: layout.compact ? 75 : 90, alignItems: "center" as const, gap: 6 },
      track: {
        width: "100%" as const,
        flexDirection: "row" as const,
        alignItems: "center" as const,
      },
      line: { flex: 1, height: 1, backgroundColor: theme.colors.border },
      dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1 },
      stepText: { fontSize: 11, textAlign: "center" as const },
      empty: { paddingVertical: 28, paddingHorizontal: 16, gap: 8 },
    }),
    [theme, layout.compact],
  );
}

export function MissionStageRail(props: PluginSurfaceProps & { stages: readonly MissionStage[] }) {
  const styles = useSummaryStyles(props);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.rail}>
        {props.stages.map((stage) => (
          <MissionStageStep key={stage.id} {...props} stage={stage} />
        ))}
      </View>
    </ScrollView>
  );
}

function MissionStageStep(props: PluginSurfaceProps & { stage: MissionStage }) {
  const styles = useSummaryStyles(props);
  const color = missionStageColor(props.theme, props.stage.status);
  const dotStyle = useMemo(
    () => [
      styles.dot,
      {
        borderColor: color,
        backgroundColor: ["working", "completed"].includes(props.stage.status)
          ? color
          : "transparent",
      },
    ],
    [styles.dot, color, props.stage.status],
  );
  const textStyle = useMemo(() => [styles.stepText, { color }], [styles.stepText, color]);
  return (
    <View
      style={styles.step}
      accessibilityLabel={`${props.stage.title}: ${missionStageLabels[props.stage.status]}`}
    >
      <View style={styles.track}>
        <View style={styles.line} />
        <View style={dotStyle} />
        <View style={styles.line} />
      </View>
      <Text style={textStyle}>{props.stage.title}</Text>
    </View>
  );
}

export function MissionSummaryRow(
  props: PluginSurfaceProps & {
    state: TeamState;
    workflow?: MissionWorkflow;
    agents?: MissionAgents;
    selected?: boolean;
    onOpen?(id: string): void;
  },
) {
  const styles = useSummaryStyles(props);
  const agents = props.agents ?? noAgents;
  const summary = missionSummary(props.state, props.workflow, agents);
  const { onOpen } = props;
  const id = props.state.team.id;
  const open = useCallback(() => onOpen?.(id), [onOpen, id]);
  const accessibilityState = useMemo(() => ({ disabled: !onOpen }), [onOpen]);
  const statusStyle = useMemo(
    () => [
      styles.pill,
      {
        color: summary.needsYou
          ? props.theme.colors.statusWarning
          : props.theme.colors.foregroundMuted,
      },
    ],
    [styles.pill, summary.needsYou, props.theme],
  );
  const cardStyle = useMemo(
    () => [
      styles.card,
      { borderColor: props.selected ? props.theme.colors.accent : props.theme.colors.border },
    ],
    [styles.card, props.selected, props.theme],
  );
  const project = summary.projectPath.split(/[/\\]/).findLast(Boolean) || summary.projectPath;
  return (
    <View style={cardStyle}>
      <Pressable
        style={styles.content}
        accessibilityRole="button"
        accessibilityLabel={`Open mission ${summary.title}`}
        accessibilityState={accessibilityState}
        disabled={!onOpen}
        onPress={open}
      >
        <View style={styles.row}>
          <Text numberOfLines={2} style={styles.title}>
            {summary.title}
          </Text>
          <Text style={statusStyle}>{summary.statusLabel}</Text>
        </View>
        <Text style={styles.muted}>
          {project} / {summary.currentStage}
        </Text>
        {!props.layout.compact && summary.stages.length ? (
          <MissionStageRail {...props} stages={summary.stages} />
        ) : null}
      </Pressable>
      <View style={styles.footer}>
        <View style={styles.metadata}>
          <Text style={styles.muted}>
            {props.workflow
              ? `${summary.completedItems} / ${summary.totalItems} complete`
              : "Progress unavailable"}
          </Text>
          <Text style={styles.muted}>
            {summary.unobservedCount
              ? "Some activity unavailable"
              : `${summary.workingCount} working`}
          </Text>
          <Text style={styles.muted}>Age {missionAge(summary.ageMs)}</Text>
        </View>
        <Action
          theme={props.theme}
          title="Open"
          value={id}
          onAction={onOpen ?? open}
          disabled={!onOpen}
        />
      </View>
    </View>
  );
}

export function MissionList(
  props: PluginSurfaceProps & {
    teams: readonly TeamState[];
    packs: readonly MissionPack[];
    agents?: MissionAgents;
    projectPath?: string;
    selected?: string;
    onOpen(id: string): void;
    onNew?(): void;
    onSchedules?(): void;
  },
) {
  const styles = useSummaryStyles(props);
  const [filter, setFilter] = useState<MissionFilter | "scheduled">("active");
  const readSchedules = useRpc(factoryScheduleList);
  const schedules = useQuery({
    queryKey: ["factory", "schedules"],
    queryFn: () => readSchedules({}),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const visibleSchedules = (schedules.data?.schedules ?? []).filter(
    (schedule) =>
      !props.projectPath ||
      schedule.target.cwd === props.projectPath ||
      schedule.target.cwd.startsWith(props.projectPath + "/"),
  );
  const summaries = props.teams.map((state) =>
    missionSummary(state, missionWorkflowFor(state, props.packs), props.agents),
  );
  const rows = filter === "scheduled" ? [] : filterMissions(summaries, filter);
  const counts: Record<typeof filter, number> = {
    active: filterMissions(summaries, "active").length,
    "needs-you": filterMissions(summaries, "needs-you").length,
    completed: filterMissions(summaries, "completed").length,
    all: summaries.length,
    scheduled: visibleSchedules.length,
  };
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        {filters.map((entry) => (
          <Action
            key={entry.id}
            theme={props.theme}
            title={counts[entry.id] ? `${entry.title} (${counts[entry.id]})` : entry.title}
            selected={filter === entry.id}
            value={entry.id}
            onAction={setFilter}
          />
        ))}
      </View>
      {filter === "scheduled" ? (
        <View style={styles.stack}>
          {schedules.isPending ? (
            <Text style={styles.caption}>Loading scheduled missions…</Text>
          ) : null}
          {schedules.error ? (
            <Text style={styles.caption}>
              Scheduled missions unavailable: {String(schedules.error)}
            </Text>
          ) : null}
          {visibleSchedules.map((schedule) => (
            <MissionScheduleRow key={schedule.id} {...props} schedule={schedule} />
          ))}
          {props.onSchedules ? (
            <Action
              theme={props.theme}
              title="Manage schedules"
              value={null}
              onAction={props.onSchedules}
            />
          ) : null}
          {!visibleSchedules.length && schedules.isSuccess ? (
            <Text style={styles.caption}>No scheduled missions yet.</Text>
          ) : null}
        </View>
      ) : (
        rows.map((summary) => {
          const state = props.teams.find((candidate) => candidate.team.id === summary.teamId)!;
          return (
            <MissionSummaryRow
              key={summary.teamId}
              {...props}
              state={state}
              selected={summary.teamId === props.selected}
              workflow={missionWorkflowFor(state, props.packs)}
            />
          );
        })
      )}
      {filter !== "scheduled" && !rows.length ? (
        <View style={styles.empty}>
          <Text style={styles.heading}>
            {summaries.length ? "No missions in this view" : "No missions yet"}
          </Text>
          <Text style={styles.caption}>
            {summaries.length
              ? "Choose another filter to see the rest of your missions."
              : "Start with an outcome. Kitchen will plan the work and assign the team."}
          </Text>
          {props.onNew ? (
            <Action
              theme={props.theme}
              title="Start mission"
              value={null}
              onAction={props.onNew}
              variant="primary"
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function MissionScheduleRow(
  props: PluginSurfaceProps & {
    schedule: KitchenSchedule;
    onOpen(id: string): void;
    onSchedules?(): void;
  },
) {
  const styles = useSummaryStyles(props);
  const { schedule, onOpen } = props;
  const last = schedule.runs.at(-1);
  const open = useCallback(() => {
    if (last?.teamId) onOpen(last.teamId);
  }, [onOpen, last?.teamId]);
  return (
    <View style={styles.card}>
      <View style={styles.content}>
        <View style={styles.row}>
          <Text style={styles.title}>{schedule.name}</Text>
          <Text style={styles.pill}>{schedule.status}</Text>
        </View>
        <Text style={styles.caption}>{schedule.target.title}</Text>
        <Text style={styles.muted}>
          Next kickoff{" "}
          {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "not scheduled"}
        </Text>
        {last?.error ? <Text style={styles.caption}>{last.error}</Text> : null}
        {last?.teamId ? (
          <Action theme={props.theme} title="Open latest mission" value={null} onAction={open} />
        ) : null}
      </View>
    </View>
  );
}
