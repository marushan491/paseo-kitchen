import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import {
  factoryScheduleList,
  factoryScheduleSave,
  factoryScheduleControl,
  type KitchenSchedule,
  type StartKitchenInput,
} from "../shared/factory-contracts.js";
import { Action, Field, useFactoryStyles } from "./ui.js";

type Target = Omit<StartKitchenInput, "idempotencyKey" | "scheduleId">;
type ScheduleAction = "pause" | "resume" | "run-once" | "delete";

export function KitchenSchedules(
  props: PluginSurfaceProps & { target: Target; validTarget: boolean; onOpenRun(id: string): void },
) {
  const styles = useFactoryStyles(props);
  const read = useRpc(factoryScheduleList);
  const [editing, setEditing] = useState("");
  const schedules = useQuery({
    queryKey: ["factory", "schedules"],
    queryFn: () => read({}),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const selected = schedules.data?.schedules.find((schedule) => schedule.id === editing);
  return (
    <View style={styles.stack}>
      <Text style={styles.title}>Kitchen triggers</Text>
      <Text style={styles.muted}>
        Each trigger dispatches a Kitchen run with its saved goal and acceptance criteria.
        Successful dispatch does not mean the product was accepted.
      </Text>
      {schedules.error ? <Text style={styles.danger}>{String(schedules.error)}</Text> : null}
      {schedules.isPending ? <Text style={styles.muted}>Loading schedules…</Text> : null}
      {schedules.data?.schedules.map((schedule) => (
        <ScheduleRow key={schedule.id} {...props} schedule={schedule} onEdit={setEditing} />
      ))}
      {schedules.data?.schedules.length === 0 ? (
        <Text style={styles.muted}>No scheduled Kitchen runs yet.</Text>
      ) : null}
      <Action
        theme={props.theme}
        title="New scheduled job from start form"
        value=""
        onAction={setEditing}
      />
      <ScheduleEditor key={selected?.id || "new"} {...props} schedule={selected} />
    </View>
  );
}

function ScheduleRow(
  props: PluginSurfaceProps & {
    schedule: KitchenSchedule;
    onEdit(id: string): void;
    onOpenRun(id: string): void;
  },
) {
  const { schedule, theme, onEdit, onOpenRun } = props;
  const styles = useFactoryStyles(props);
  const rpc = useRpc(factoryScheduleControl);
  const cache = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mutation = useMutation({
    mutationFn: (action: ScheduleAction) => rpc({ id: schedule.id, action, actorId: "human" }),
    onSuccess: async () => {
      setConfirmDelete(false);
      await cache.invalidateQueries({ queryKey: ["factory"] });
    },
  });
  const control = useCallback(
    (action: ScheduleAction) => {
      if (action === "delete" && !confirmDelete) setConfirmDelete(true);
      else mutation.mutate(action);
    },
    [mutation, confirmDelete],
  );
  const dismiss = useCallback(() => setConfirmDelete(false), []);
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>
        {schedule.name} · {schedule.status}
      </Text>
      <Text style={styles.text}>
        {schedule.target.title} · {schedule.target.cwd}
      </Text>
      <Text style={styles.muted}>
        {schedule.cadence.type === "cron"
          ? `${schedule.cadence.expression} · ${schedule.cadence.timezone || "UTC"}`
          : `Every ${schedule.cadence.everyMs / 60000} minutes`}{" "}
        · Next: {schedule.nextRunAt || "none"}
      </Text>
      <Text style={styles.muted}>
        Run limit: {schedule.maxRuns ?? "none"} · Expires: {schedule.expiresAt || "never"}
      </Text>
      {mutation.error ? <Text style={styles.danger}>{String(mutation.error)}</Text> : null}
      <View style={styles.row}>
        <Action
          theme={theme}
          title="Edit trigger"
          value={schedule.id}
          onAction={onEdit}
          disabled={mutation.isPending}
        />
        <Action
          theme={theme}
          title="Run once now"
          value="run-once"
          onAction={control}
          disabled={mutation.isPending}
        />
        <Action
          theme={theme}
          title="Pause trigger"
          value="pause"
          onAction={control}
          disabled={mutation.isPending || schedule.status !== "active"}
        />
        <Action
          theme={theme}
          title="Resume trigger"
          value="resume"
          onAction={control}
          disabled={mutation.isPending || schedule.status !== "paused"}
        />
        <Action
          theme={theme}
          title={confirmDelete ? "Confirm delete trigger" : "Delete trigger"}
          value="delete"
          onAction={control}
          disabled={mutation.isPending}
        />
        {confirmDelete ? (
          <Action theme={theme} title="Keep trigger" value="keep" onAction={dismiss} />
        ) : null}
      </View>
      {schedule.runs.map((run) => (
        <View key={run.slot} style={styles.stack}>
          <Text style={styles.text}>
            {run.scheduledFor} · {run.status} · attempt {run.attempts}
          </Text>
          {run.error ? <Text style={styles.danger}>{run.error}</Text> : null}
          {run.retryAt ? <Text style={styles.muted}>Retry: {run.retryAt}</Text> : null}
          {run.teamId ? (
            <Action
              theme={theme}
              title="Open dispatched Kitchen"
              value={run.teamId}
              onAction={onOpenRun}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function ScheduleEditor(
  props: PluginSurfaceProps & { schedule?: KitchenSchedule; target: Target; validTarget: boolean },
) {
  const { schedule, theme, target, validTarget } = props;
  const styles = useFactoryStyles(props);
  const rpc = useRpc(factoryScheduleSave);
  const cache = useQueryClient();
  const initial = scheduleFields(schedule);
  const [name, setName] = useState(initial.name);
  const [kind, setKind] = useState<"cron" | "every">(initial.kind);
  const [cron, setCron] = useState(initial.cron);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [minutes, setMinutes] = useState(initial.minutes);
  const [maxRuns, setMaxRuns] = useState(initial.maxRuns);
  const [expires, setExpires] = useState(initial.expires);
  const savedTarget = schedule?.target || target;
  const valid = scheduleFormValid(
    { name, kind, cron, minutes, maxRuns, expires },
    Boolean(schedule) || validTarget,
  );
  const save = useMutation({
    mutationFn: () =>
      rpc({
        id: schedule?.id,
        name: name.trim(),
        cadence:
          kind === "cron"
            ? { type: "cron", expression: cron.trim(), timezone: timezone.trim() || undefined }
            : { type: "every", everyMs: Math.round(Number(minutes) * 60000) },
        target: savedTarget,
        maxRuns: maxRuns ? Number(maxRuns) : null,
        expiresAt: expires.trim() || null,
        actorId: "human",
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["factory", "schedules"] }),
  });
  const submit = useCallback(() => save.mutate(), [save]);
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>
        {schedule ? "Edit scheduled job" : "Schedule the start form's job"}
      </Text>
      <Text style={styles.muted}>
        {savedTarget.title || "Fill in the job title"} · {savedTarget.provider || "Select provider"}{" "}
        · {savedTarget.cwd || "Select project"}
      </Text>
      <Text style={styles.text}>{savedTarget.objective}</Text>
      {savedTarget.acceptanceCriteria.map((criterion) => (
        <Text key={criterion.id} style={styles.muted}>
          {criterion.text}
        </Text>
      ))}
      <Field theme={theme} label="Trigger name" value={name} onChange={setName} />
      <View style={styles.row}>
        <Action theme={theme} title="Cron" value={"cron" as const} onAction={setKind} />
        <Action theme={theme} title="Interval" value={"every" as const} onAction={setKind} />
      </View>
      {kind === "cron" ? (
        <>
          <Field theme={theme} label="Cron expression" value={cron} onChange={setCron} />
          <Field
            theme={theme}
            label="Timezone · IANA timezone, defaults to UTC"
            value={timezone}
            onChange={setTimezone}
          />
        </>
      ) : (
        <Field theme={theme} label="Interval in minutes" value={minutes} onChange={setMinutes} />
      )}
      <Field theme={theme} label="Maximum runs · optional" value={maxRuns} onChange={setMaxRuns} />
      <Field
        theme={theme}
        label="Expires at · optional ISO timestamp"
        value={expires}
        onChange={setExpires}
      />
      {save.error ? <Text style={styles.danger}>{String(save.error)}</Text> : null}
      {save.isSuccess ? <Text style={styles.text}>Trigger saved.</Text> : null}
      <Action
        theme={theme}
        title={save.isPending ? "Saving trigger…" : "Save trigger"}
        value="save"
        onAction={submit}
        disabled={save.isPending || !valid}
      />
    </View>
  );
}

function scheduleFields(schedule?: KitchenSchedule) {
  return {
    name: schedule?.name || "",
    kind: schedule?.cadence.type || "cron",
    cron: schedule?.cadence.type === "cron" ? schedule.cadence.expression : "0 9 * * 1-5",
    timezone: schedule?.cadence.type === "cron" ? schedule.cadence.timezone || "" : "",
    minutes: schedule?.cadence.type === "every" ? String(schedule.cadence.everyMs / 60000) : "60",
    maxRuns: schedule?.maxRuns ? String(schedule.maxRuns) : "",
    expires: schedule?.expiresAt || "",
  };
}

function scheduleFormValid(
  fields: {
    name: string;
    kind: "cron" | "every";
    cron: string;
    minutes: string;
    maxRuns: string;
    expires: string;
  },
  validTarget: boolean,
) {
  return Boolean(
    fields.name.trim() &&
    validTarget &&
    (fields.kind === "cron" ? fields.cron.trim() : Number(fields.minutes) > 0) &&
    (!fields.maxRuns || (Number.isInteger(Number(fields.maxRuns)) && Number(fields.maxRuns) > 0)) &&
    (!fields.expires || Number.isFinite(Date.parse(fields.expires))),
  );
}
