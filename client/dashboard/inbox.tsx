import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { getPaseoClient, usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { dashboardSchedule } from "../../shared/dashboard/contracts.js";
import {
  availableSnoozeOptions,
  type InboxItem,
  type SnoozeOption,
} from "../../shared/dashboard/inbox-model.js";
import { isSessionMarkedDone } from "../../shared/dashboard/session-model.js";
import type { DashboardState } from "./state.js";
import { Action, Field, useDashboardStyles } from "./ui.js";

const LABELS = {
  permission: "Permission",
  question: "Question",
  routing_wait: "Provider blocked",
  agent_error: "Agent failed",
  schedule_error: "Schedule failed",
  checks_failed: "Checks failed",
  merge_ready: "Ready to merge",
  finished: "Your turn",
};
const SNOOZES = { hour: "One hour", evening: "This evening", morning: "Tomorrow morning" };

function reason(item: InboxItem): string {
  if (item.kind === "routing_wait") {
    const reset = item.resetsAt ? new Date(item.resetsAt) : null;
    const resetText =
      reset && Number.isFinite(reset.getTime())
        ? ` · Reported reset: ${reset.toLocaleString()}`
        : "";
    return `${item.status === "waiting" ? "Waiting" : "Exhausted"}: ${item.reason}${resetText}`;
  }
  if (item.kind === "permission") return `${item.agentLabel}: ${item.request}`;
  if (item.kind === "agent_error" || item.kind === "schedule_error")
    return item.error || "No error details available";
  if (item.kind === "finished")
    return (
      item.need ||
      (item.handoffKind
        ? `Handoff: ${item.handoffKind}`
        : "The agent handed the turn back. Reply or mark this session done.")
    );
  if (item.kind === "checks_failed")
    return `${item.failingCount} change requests have failing checks`;
  if (item.kind === "merge_ready")
    return `Change request #${item.pullRequest.number} passed checks`;
  return "The agent is waiting for your reply";
}

function useInbox(props: PluginSurfaceProps & { item: InboxItem; state: DashboardState }) {
  const { item, state, navigation, theme } = props;
  const styles = useDashboardStyles(props);
  const own = usePaseo();
  const schedule = useRpc(dashboardSchedule);
  const [expanded, setExpanded] = useState(false);
  const toggleDetails = useCallback(() => setExpanded((value) => !value), []);
  const [reply, setReply] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"pause" | "run-once" | null>(null);
  const session =
    item.kind === "schedule_error"
      ? null
      : state.sessions.find((candidate) => candidate.key === item.sessionKey);
  const agentId = "agentId" in item ? item.agentId : null;
  const api = useMemo(() => {
    try {
      return item.serverId === props.host.id ? own : getPaseoClient(item.serverId);
    } catch {
      return null;
    }
  }, [item.serverId, props.host.id, own]);
  const execute = useCallback(async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Action failed");
    } finally {
      setPending(false);
    }
  }, []);
  useEffect(() => {
    if (!expanded || !api || !agentId || item.kind === "permission") return;
    let disposed = false;
    void api.agents
      .ref(agentId)
      .timeline.refetch({ limit: 100, direction: "tail" })
      .then((page) => {
        const texts = page.entries.filter((entry) => entry.item.type === "assistant_message");
        const last = texts.at(-1)?.item;
        if (!disposed && last?.type === "assistant_message") setPreview(last.text.slice(0, 280));
        return null;
      })
      .catch(() => {
        if (!disposed) setPreview(null);
      });
    return () => {
      disposed = true;
    };
  }, [api, agentId, item.kind, expanded]);
  const open = useCallback(() => {
    if (agentId) navigation?.openAgent({ agentId, serverId: item.serverId });
    else if (item.workspaceId)
      navigation?.openWorkspace({ workspaceId: item.workspaceId, serverId: item.serverId });
  }, [navigation, agentId, item]);
  const send = useCallback(() => {
    if (!api || !agentId || !reply.trim()) return;
    void execute(async () => {
      await api.agents.ref(agentId).send(reply.trim());
      setReply("");
      await state.refresh();
    });
  }, [api, agentId, reply, execute, state]);
  const snooze = useCallback(
    (option: SnoozeOption) => {
      void execute(() => state.snooze(item.id, option));
    },
    [execute, state, item.id],
  );
  const done = useCallback(() => {
    if (session) void execute(() => state.markDone(session.key, !isSessionMarkedDone(session)));
  }, [session, execute, state]);
  const askSchedule = useCallback((action: "pause" | "run-once") => setConfirmation(action), []);
  const dismiss = useCallback(() => setConfirmation(null), []);
  const confirm = useCallback(() => {
    if (item.kind !== "schedule_error" || !confirmation) return;
    void execute(async () => {
      await schedule({
        id: item.scheduleId,
        action: confirmation,
        target:
          item.serverId === props.host.id
            ? { kind: "local" }
            : { kind: "remote", serverId: item.serverId },
      });
      setConfirmation(null);
      await state.refresh();
    });
  }, [item, confirmation, execute, schedule, state, props.host.id]);
  const scheduleEntry =
    item.kind === "schedule_error"
      ? state.schedules.find(
          (entry) => entry.serverId === item.serverId && entry.schedule.id === item.scheduleId,
        )
      : undefined;
  const canControlSchedule =
    scheduleEntry?.schedule.target.type === "new-agent" &&
    scheduleEntry.schedule.status !== "completed";
  const options = availableSnoozeOptions(new Date());
  const canOpen = Boolean(navigation && (agentId || item.workspaceId));
  return {
    item,
    theme,
    canOpen,
    styles,
    expanded,
    toggleDetails,
    preview,
    open,
    options,
    snooze,
    pending,
    session,
    done,
    agentId,
    api,
    reply,
    setReply,
    send,
    askSchedule,
    canControlSchedule,
    scheduleEntry,
    confirmation,
    confirm,
    dismiss,
    error,
  };
}

export function InboxCard(props: PluginSurfaceProps & { item: InboxItem; state: DashboardState }) {
  const {
    item,
    theme,
    canOpen,
    styles,
    expanded,
    toggleDetails,
    preview,
    open,
    options,
    snooze,
    pending,
    session,
    done,
    agentId,
    api,
    reply,
    setReply,
    send,
    askSchedule,
    canControlSchedule,
    scheduleEntry,
    confirmation,
    confirm,
    dismiss,
    error,
  } = useInbox(props);
  return (
    <View style={styles.card}>
      <Text style={styles.heading} numberOfLines={2}>
        {LABELS[item.kind]} · {item.title}
      </Text>
      <Text style={styles.muted}>
        {item.projectName} · {timestamp(item.since)}
      </Text>
      <Text style={styles.text} numberOfLines={expanded ? undefined : 1}>
        {reason(item)}
      </Text>
      <View style={styles.row}>
        <Action
          theme={theme}
          title="Open"
          value={null}
          onAction={open}
          disabled={!canOpen}
          variant="primary"
        />
        <Action
          theme={theme}
          title={expanded ? "Hide details" : "Details"}
          value={null}
          onAction={toggleDetails}
          selected={expanded}
        />
      </View>
      {expanded ? (
        <View style={styles.stack}>
          {preview ? <Text style={styles.muted}>{preview}</Text> : null}
          <View style={styles.row}>
            {options.map((option) => (
              <Action
                key={option}
                theme={theme}
                title={`Snooze · ${SNOOZES[option]}`}
                value={option}
                onAction={snooze}
                disabled={pending}
              />
            ))}
            {session ? (
              <Action
                theme={theme}
                title="Mark done in dashboard"
                value={null}
                onAction={done}
                disabled={pending}
              />
            ) : null}
          </View>
          {agentId && item.kind !== "permission" && item.kind !== "routing_wait" ? (
            <Reply
              props={props}
              reply={reply}
              onChange={setReply}
              send={send}
              pending={pending || !api}
            />
          ) : null}
          {item.kind === "schedule_error" ? (
            <View style={styles.row}>
              <Action
                theme={theme}
                title="Retry once…"
                value="run-once"
                onAction={askSchedule}
                disabled={pending || !canControlSchedule}
              />
              <Action
                theme={theme}
                title="Pause schedule…"
                value="pause"
                onAction={askSchedule}
                disabled={pending || !canControlSchedule}
              />
            </View>
          ) : null}
          {item.kind === "schedule_error" && !canControlSchedule ? (
            <Text style={styles.muted}>
              {scheduleEntry?.schedule.status === "completed"
                ? "This schedule has completed. Create a new schedule in Schedules to run it again."
                : "Heartbeat controls require the owning agent. Open its agent to manage it."}
            </Text>
          ) : null}
          {confirmation ? (
            <View style={styles.stack}>
              <Text style={styles.text}>
                {confirmation === "pause"
                  ? "Pause future runs of this schedule?"
                  : "Run this schedule once now? This starts agent work."}
              </Text>
              <Action
                theme={theme}
                title="Confirm"
                value={null}
                onAction={confirm}
                disabled={pending}
              />
              <Action
                theme={theme}
                title="Keep unchanged"
                value={null}
                onAction={dismiss}
                disabled={pending}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}

function Reply({
  props,
  reply,
  onChange,
  send,
  pending,
}: {
  props: PluginSurfaceProps;
  reply: string;
  onChange(text: string): void;
  send(): void;
  pending: boolean;
}) {
  const styles = useDashboardStyles(props);
  return (
    <View style={styles.stack}>
      <Field
        theme={props.theme}
        label="Reply to the agent"
        value={reply}
        onChange={onChange}
        multiline
      />
      <Action
        theme={props.theme}
        title="Send reply"
        variant="primary"
        value={null}
        onAction={send}
        disabled={pending || !reply.trim()}
      />
    </View>
  );
}

function timestamp(since: Date | null): string {
  return since?.toLocaleString() || "Timestamp unavailable";
}
