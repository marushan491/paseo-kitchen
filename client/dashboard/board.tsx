import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { openExternalUrl, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { recentCompletedSessions } from "../../shared/dashboard/overview.js";
import { dashboardSchedule } from "../../shared/dashboard/contracts.js";
import {
  buildLeitstandBoard,
  arrangeBoardColumns,
  isSessionMarkedDone,
  type LeitstandSession,
  type LeitstandSchedule,
  type SessionColumn,
} from "../../shared/dashboard/session-model.js";
import { buildJiraIssueUrl, normalizeJiraSite } from "../../shared/dashboard/jira.js";
import type { DashboardState } from "./state.js";
import { Action, Field, useDashboardStyles } from "./ui.js";

export function Board(props: PluginSurfaceProps & { state: DashboardState; jiraSite: string }) {
  const styles = useDashboardStyles(props);
  const [project, setProject] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);
  const togglePicking = useCallback(() => setPicking((value) => !value), []);
  const chooseProject = useCallback((value: string | null) => {
    setProject(value);
    setPicking(false);
    setSearch("");
  }, []);
  const { state, theme } = props;
  const projects = useMemo(
    () => [
      ...new Map(
        state.sessions.map((session) => [session.projectViewKey, session.projectName]),
      ).entries(),
    ],
    [state.sessions],
  );
  const selected = projects.some(([id]) => id === project) ? project : null;
  const board = useMemo(
    () =>
      buildLeitstandBoard({
        sessions: state.sessions,
        schedules: state.schedules,
        projectViewKey: selected,
      }),
    [state.sessions, state.schedules, selected],
  );
  const columns = useMemo(() => arrangeBoardColumns(board), [board]);
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Text style={styles.heading}>Activity</Text>
        <Action
          theme={theme}
          title={projects.find(([id]) => id === selected)?.[1] || "All projects"}
          value={null}
          onAction={togglePicking}
          variant="secondary"
          selected={picking}
        />
      </View>
      {picking ? (
        <View style={styles.stack}>
          <Field theme={theme} label="Search projects" value={search} onChange={setSearch} />
          <Action
            theme={theme}
            title="All projects"
            value={null}
            onAction={chooseProject}
            selected={!selected}
          />
          {projects
            .filter(([, title]) => title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
            .map(([id, title]) => (
              <Action
                key={id}
                theme={theme}
                title={title}
                value={id}
                onAction={chooseProject}
                selected={selected === id}
              />
            ))}
        </View>
      ) : null}
      <View style={styles.stack}>
        {(["running", "waiting", "done"] as const).map((column) => (
          <BoardColumn key={column} {...props} column={column} entries={columns[column]} />
        ))}
        <View style={styles.main}>
          <Text style={styles.heading}>Planned · {board.planned.length}</Text>
          {board.planned.map((entry) => (
            <ScheduleCard key={entry.key} {...props} entry={entry} />
          ))}
          {board.planned.length === 0 ? (
            <Text style={styles.muted}>No planned runs from this host.</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function BoardColumn(
  props: PluginSurfaceProps & {
    state: DashboardState;
    jiraSite: string;
    column: SessionColumn;
    entries: ReturnType<typeof arrangeBoardColumns>[SessionColumn];
  },
) {
  const styles = useDashboardStyles(props);
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const sessions = props.entries.flatMap((entry) =>
    entry.kind === "session" ? [entry.session] : entry.children,
  );
  const visible =
    props.column === "done" && !expanded
      ? recentCompletedSessions(sessions).map((session) => ({ kind: "session" as const, session }))
      : props.entries;
  return (
    <View style={styles.main}>
      <Text style={styles.heading}>
        {{ running: "Running", waiting: "Waiting", done: "Completed" }[props.column]} ·{" "}
        {sessions.length}
      </Text>
      {props.column === "done" ? (
        <Action
          theme={props.theme}
          title={expanded ? "Show recent only" : `Show all completed · ${sessions.length}`}
          value={null}
          onAction={toggle}
          selected={expanded}
        />
      ) : null}
      {visible.map((entry) =>
        entry.kind === "session" ? (
          <SessionCard key={entry.session.key} {...props} session={entry.session} />
        ) : (
          <View key={entry.key} style={styles.stack}>
            <Text style={styles.heading}>{entry.topic.title}</Text>
            {entry.topic.description ? (
              <Text style={styles.muted}>{entry.topic.description}</Text>
            ) : null}
            {entry.children.map((session) => (
              <SessionCard key={session.key} {...props} session={session} />
            ))}
          </View>
        ),
      )}
      {props.entries.length === 0 ? <Text style={styles.muted}>No workspaces.</Text> : null}
    </View>
  );
}

function SessionCard(
  props: PluginSurfaceProps & {
    state: DashboardState;
    jiraSite: string;
    session: LeitstandSession;
  },
) {
  const { session, state, navigation, theme } = props;
  const styles = useDashboardStyles(props);
  const [expanded, setExpanded] = useState(false);
  const toggleDetails = useCallback(() => setExpanded((value) => !value), []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const open = useCallback(
    () =>
      navigation?.openWorkspace({ workspaceId: session.workspaceId, serverId: session.serverId }),
    [navigation, session],
  );
  const openAgent = useCallback(
    (agentId: string) => navigation?.openAgent({ agentId, serverId: session.serverId }),
    [navigation, session.serverId],
  );
  const link = useCallback((url: string) => {
    void openExternalUrl(url);
  }, []);
  const done = useCallback(() => {
    setPending(true);
    setError(null);
    void state
      .markDone(session.key, !isSessionMarkedDone(session))
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Could not mark session"),
      )
      .finally(() => setPending(false));
  }, [state, session]);
  const jira = normalizeJiraSite(props.jiraSite);
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{session.name}</Text>
      <Text style={styles.muted}>
        {session.projectName} · {session.branch || "No branch"}
      </Text>
      <View style={styles.row}>
        <Action
          theme={theme}
          title="Open workspace"
          value={null}
          onAction={open}
          disabled={!navigation}
        />
        <Action
          theme={theme}
          title={expanded ? "Hide details" : "Details"}
          value={null}
          onAction={toggleDetails}
          selected={expanded}
        />
        <Action
          theme={theme}
          title={isSessionMarkedDone(session) ? "Reopen in dashboard" : "Done in dashboard"}
          value={null}
          onAction={done}
          disabled={pending}
        />
      </View>
      <Text style={styles.muted}>
        {session.agents.length} agents ·{" "}
        {session.agents.filter((agent) => agent.bucket === "running").length} running ·{" "}
        {session.pullRequests.length} change requests
      </Text>
      {state.kitchenCompletions[session.key] ? (
        <Text style={styles.muted}>
          Kitchen result accepted · Dashboard Reopen changes visibility only; it does not reopen
          execution.
        </Text>
      ) : null}
      {expanded ? (
        <View style={styles.stack}>
          {session.agents.map((agent) => (
            <Action
              key={agent.id}
              theme={theme}
              title={`${agent.title || agent.provider} · ${agent.model || agent.provider} · ${agent.bucket}`}
              value={agent.id}
              onAction={openAgent}
              disabled={!navigation}
            />
          ))}
          {session.pullRequests.map((pr) => (
            <Action
              key={pr.url}
              theme={theme}
              title={`#${pr.number} · ${pr.state} · ${pr.checksStatus || "Checks unknown"}`}
              value={pr.url}
              onAction={link}
            />
          ))}
          {jira
            ? session.jiraKeys.map((key) => (
                <Action
                  key={key}
                  theme={theme}
                  title={key}
                  value={buildJiraIssueUrl(jira, key)}
                  onAction={link}
                />
              ))
            : session.jiraKeys.map((key) => (
                <Text key={key} style={styles.muted}>
                  {key}
                </Text>
              ))}
        </View>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}

function ScheduleCard(
  props: PluginSurfaceProps & { state: DashboardState; entry: LeitstandSchedule },
) {
  const { entry, theme, state } = props;
  const styles = useDashboardStyles(props);
  const control = useRpc(dashboardSchedule);
  const [action, setAction] = useState<"pause" | "run-once" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = useCallback(() => setAction(null), []);
  const confirm = useCallback(() => {
    if (!action) return;
    setPending(true);
    setError(null);
    void control({
      id: entry.schedule.id,
      action,
      target:
        entry.serverId === props.host.id
          ? { kind: "local" }
          : { kind: "remote", serverId: entry.serverId },
    })
      .then(async () => {
        setAction(null);
        await state.refresh();
        return true;
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Schedule action failed"),
      )
      .finally(() => setPending(false));
  }, [action, entry.schedule.id, entry.serverId, props.host.id, control, state]);
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{entry.schedule.name || entry.schedule.prompt}</Text>
      <Text style={styles.muted}>
        {entry.projectName || "Project unavailable"} · {entry.schedule.nextRunAt}
      </Text>
      <Text style={styles.text} numberOfLines={2}>
        {entry.schedule.prompt}
      </Text>
      <View style={styles.row}>
        <Action
          theme={theme}
          title="Run once…"
          value={"run-once" as const}
          onAction={setAction}
          disabled={pending || entry.schedule.target.type !== "new-agent"}
        />
        <Action
          theme={theme}
          title="Pause…"
          value={"pause" as const}
          onAction={setAction}
          disabled={pending || entry.schedule.target.type !== "new-agent"}
        />
      </View>
      {action ? (
        <View style={styles.stack}>
          <Text style={styles.text}>
            {action === "pause" ? "Pause future schedule runs?" : "Start an additional run now?"}
          </Text>
          <Action
            theme={theme}
            title="Confirm"
            variant="primary"
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
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}
