import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import {
  factoryScheduleList,
  factoryScheduleControl,
  factoryList,
  type KitchenSchedule,
  type TeamState,
} from "../../shared/factory-contracts.js";
import { Action, useDashboardStyles } from "./ui.js";
import { visibleKitchenSchedules } from "../../shared/dashboard/kitchen-schedules.js";

type ScheduleControl = "pause" | "resume" | "run-once";
type Props = PluginSurfaceProps & {
  projectPath?: string;
  section: "overview" | "activity" | "problems";
  onOpenTeam?: (teamId?: string) => void;
};

export function KitchenScheduleOverview(props: Props) {
  const styles = useDashboardStyles(props);
  const read = useRpc(factoryScheduleList);
  const list = useRpc(factoryList);
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const schedules = useQuery({
    queryKey: ["factory", "schedules"],
    queryFn: () => read({}),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const teams = useQuery({
    queryKey: ["factory", "teams"],
    queryFn: () => list({}),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const entries = visibleKitchenSchedules(
    (schedules.data?.schedules ?? []).filter(
      (entry) =>
        !props.projectPath ||
        entry.target.cwd === props.projectPath ||
        entry.target.cwd?.startsWith(props.projectPath + "/"),
    ),
    props.section === "problems",
  );
  const visible = expanded ? entries : entries.slice(0, 3);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Kitchen schedules · {entries.length}</Text>
      <Text style={styles.muted}>
        Scheduled goals run through the same review and acceptance process.
      </Text>
      {schedules.isPending ? <Text style={styles.muted}>Loading Kitchen schedules…</Text> : null}
      {schedules.error ? <Text style={styles.danger}>{String(schedules.error)}</Text> : null}
      {teams.error ? (
        <Text style={styles.danger}>Linked mission status unavailable: {String(teams.error)}</Text>
      ) : null}
      {visible.map((schedule) => (
        <KitchenScheduleRow
          key={schedule.id}
          {...props}
          schedule={schedule}
          team={teams.data?.teams.find((state) => state.team.id === schedule.runs.at(-1)?.teamId)}
        />
      ))}
      {entries.length > 3 ? (
        <Action
          theme={props.theme}
          title={expanded ? "Show recent only" : `Show all Kitchen schedules · ${entries.length}`}
          value={null}
          onAction={toggle}
          selected={expanded}
        />
      ) : null}
      {!entries.length && schedules.data ? (
        <Text style={styles.muted}>
          {props.section === "problems"
            ? "No reported Kitchen kickoff failures."
            : "No Kitchen schedules yet. Create one from the mission start form."}
        </Text>
      ) : null}
    </View>
  );
}

function KitchenScheduleRow(props: Props & { schedule: KitchenSchedule; team?: TeamState }) {
  const styles = useDashboardStyles(props);
  const { schedule, onOpenTeam } = props;
  const last = schedule.runs.at(-1);
  const [confirmation, setConfirmation] = useState<ScheduleControl | null>(null);
  const dismiss = useCallback(() => setConfirmation(null), []);
  const control = useRpc(factoryScheduleControl);
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: (action: ScheduleControl) => control({ id: schedule.id, action, actorId: "human" }),
    onSuccess: async () => {
      setConfirmation(null);
      await cache.invalidateQueries({ queryKey: ["factory"] });
    },
  });
  const confirm = useCallback(() => {
    if (confirmation) mutation.mutate(confirmation);
  }, [confirmation, mutation]);
  const open = useCallback(() => {
    if (last?.teamId) onOpenTeam?.(last.teamId);
  }, [last?.teamId, onOpenTeam]);
  const inactive = schedule.status === "completed" || mutation.isPending;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>
        {schedule.name} · {schedule.status}
      </Text>
      <Text style={styles.text}>{schedule.target.title}</Text>
      <Text style={styles.muted}>Next kickoff: {schedule.nextRunAt || "none"}</Text>
      {last ? (
        <Text style={styles.muted}>
          Last kickoff: {last.status} · {last.startedAt} · attempts {last.attempts}
        </Text>
      ) : null}
      {last?.error ? <Text style={styles.danger}>{last.error}</Text> : null}
      {last?.retryAt ? <Text style={styles.muted}>Recorded retry: {last.retryAt}</Text> : null}
      {props.team ? <Text style={styles.text}>Mission: {props.team.team.status}</Text> : null}
      <View style={styles.row}>
        {last?.teamId ? (
          <Action
            theme={props.theme}
            title="Open mission"
            value={null}
            onAction={open}
            disabled={!onOpenTeam}
          />
        ) : null}
        <Action
          theme={props.theme}
          title="Run once…"
          value={"run-once" as const}
          onAction={setConfirmation}
          disabled={inactive}
        />
        <Action
          theme={props.theme}
          title={schedule.status === "paused" ? "Resume schedule…" : "Pause schedule…"}
          value={schedule.status === "paused" ? ("resume" as const) : ("pause" as const)}
          onAction={setConfirmation}
          disabled={inactive}
        />
      </View>
      {confirmation ? (
        <View style={styles.stack}>
          <Text style={styles.text}>
            {confirmation === "run-once"
              ? "Dispatch an additional Kitchen mission now using this saved goal and criteria?"
              : "Change future kickoff scheduling? Current mission execution stays separate."}
          </Text>
          <Action
            theme={props.theme}
            title="Confirm schedule change"
            variant="primary"
            value={null}
            onAction={confirm}
            disabled={mutation.isPending}
          />
          <Action
            theme={props.theme}
            title="Keep schedule unchanged"
            value={null}
            onAction={dismiss}
            disabled={mutation.isPending}
          />
        </View>
      ) : null}
      {mutation.error ? <Text style={styles.danger}>{String(mutation.error)}</Text> : null}
    </View>
  );
}
