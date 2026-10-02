import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import type { z } from "zod";
import { Text, View } from "react-native";
import {
  factoryKitchenControl,
  factoryMessage,
  factoryRetry,
  factoryStatus,
  FactoryWorkflowSchema,
  type TeamState,
  type WorkItem,
  type TeamEvent,
} from "../shared/factory-contracts.js";
import { Action, useFactoryStyles } from "./ui.js";
import { AgentTimeline } from "./timeline.js";
import { acceptanceProblem, kitchenInsights } from "./kitchen-model.js";

const views = ["Teamchat", "Agent-Pool", "Auftrag"] as const;
const jobViews = ["Übersicht", "Abnahme", "Insights", "Safety"] as const;
type Control = "pause" | "resume" | "stop" | "cancel" | "accept";

export function TeamView(props: PluginSurfaceProps & { teamId: string }) {
  const { theme, teamId, navigation } = props;
  const styles = useFactoryStyles(props);
  const read = useRpc(factoryStatus);
  const controlRpc = useRpc(factoryKitchenControl);
  const messageRpc = useRpc(factoryMessage);
  const sendToBoss = useCallback(
    async (text: string) => {
      await messageRpc({ teamId, text, actorId: "human" });
    },
    [messageRpc, teamId],
  );
  const retry = useRpc(factoryRetry);
  const cache = useQueryClient();
  const [view, setView] = useState<(typeof views)[number]>("Teamchat");
  const [jobView, setJobView] = useState<(typeof jobViews)[number]>("Übersicht");
  const [confirmation, setConfirmation] = useState<Control | null>(null);
  const team = useQuery({
    queryKey: ["factory", "team", teamId],
    queryFn: () => read({ teamId }),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const change = useMutation({
    mutationFn: async (action: Control | { retry: string }) => {
      if (typeof action === "object")
        await retry({ teamId, decisionId: action.retry, actorId: "human" });
      else await controlRpc({ teamId, action, actorId: "human" });
    },
    onSuccess: async () => {
      setConfirmation(null);
      await cache.invalidateQueries({ queryKey: ["factory"] });
    },
  });
  const control = useCallback(
    (action: Control) => {
      if (["stop", "cancel", "accept"].includes(action)) setConfirmation(action);
      else change.mutate(action);
    },
    [change],
  );
  const confirm = useCallback(() => {
    if (confirmation) change.mutate(confirmation);
  }, [change, confirmation]);
  const dismiss = useCallback(() => setConfirmation(null), []);
  const retryDecision = useCallback((id: string) => change.mutate({ retry: id }), [change]);
  const openAgent = useCallback(
    (id: string) => navigation?.openAgent({ agentId: id }),
    [navigation],
  );
  if (team.isPending) return <Text style={styles.muted}>Loading Kitchen…</Text>;
  if (!team.data) return <Text style={styles.danger}>{String(team.error)}</Text>;
  const { state, events, workflow } = team.data;
  const closed = state.team.status === "done" || state.team.status === "canceled";
  return (
    <View style={styles.stack}>
      <Text style={styles.title}>{state.team.title}</Text>
      <Text style={styles.muted}>
        {state.team.status} · {state.team.packId} · revision {state.commit} · {state.team.cwd}
      </Text>
      <Text style={styles.muted}>
        Kitchen keeps this run accessible when the native Team Agent tab is closed.
      </Text>
      <View style={styles.row}>
        <Action
          theme={theme}
          title="Open native Team Agent chat"
          value={state.team.bossAgentId}
          onAction={openAgent}
          disabled={!navigation}
        />
        {state.team.kitchen?.sourceAgentId ? (
          <Action
            theme={theme}
            title="Open source session"
            value={state.team.kitchen.sourceAgentId}
            onAction={openAgent}
            disabled={!navigation}
          />
        ) : null}
      </View>
      {state.team.pausedReason ? (
        <Text style={styles.danger}>{state.team.pausedReason}</Text>
      ) : null}
      {team.error || change.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {String(team.error || change.error)}
        </Text>
      ) : null}
      <KitchenControls
        {...props}
        state={state}
        confirmation={confirmation}
        pending={change.isPending}
        onControl={control}
        onConfirm={confirm}
        onDismiss={dismiss}
      />
      <View style={styles.row}>
        {views.map((name) => (
          <Action
            key={name}
            theme={theme}
            title={name === view ? `• ${name}` : name}
            value={name}
            onAction={setView}
          />
        ))}
      </View>
      {view === "Teamchat" ? (
        <AgentTimeline
          key={state.team.bossAgentId}
          {...props}
          agentId={state.team.bossAgentId}
          canSend={!closed}
          sendMessage={sendToBoss}
        />
      ) : null}
      {view === "Agent-Pool" ? <AgentPool {...props} state={state} workflow={workflow} /> : null}
      {view === "Auftrag" ? (
        <View style={styles.stack}>
          <View style={styles.row}>
            {jobViews.map((name) => (
              <Action
                key={name}
                theme={theme}
                title={name === jobView ? `• ${name}` : name}
                value={name}
                onAction={setJobView}
              />
            ))}
          </View>
          {jobView === "Übersicht" ? (
            <>
              <KitchenMetrics {...props} state={state} events={events} />
              <WorkBoard
                {...props}
                state={state}
                workflow={workflow}
                onRetry={retryDecision}
                pending={change.isPending || closed}
              />
              <EventLog {...props} events={events} />
            </>
          ) : null}
          {jobView === "Abnahme" ? (
            <KitchenVerification
              {...props}
              state={state}
              onControl={control}
              pending={change.isPending}
            />
          ) : null}
          {jobView === "Insights" ? (
            <KitchenMetrics {...props} state={state} events={events} detailed />
          ) : null}
          {jobView === "Safety" ? <KitchenSafety {...props} state={state} events={events} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function KitchenVerification(
  props: PluginSurfaceProps & {
    state: TeamState;
    pending: boolean;
    onControl(action: Control): void;
  },
) {
  const { state, theme, pending, onControl } = props;
  const styles = useFactoryStyles(props);
  const root = state.items[state.team.rootItemId];
  const problem = acceptanceProblem(state);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>
        Final candidate · {String(root?.pack.verifiedCommit || "Not verified yet")}
      </Text>
      {state.team.kitchen?.acceptedCommit ? (
        <Text style={styles.text}>
          Accepted {state.team.kitchen.acceptedCommit} by {state.team.kitchen.acceptedBy} at{" "}
          {state.team.kitchen.acceptedAt}
        </Text>
      ) : (
        <Text style={styles.muted}>
          {problem || "Ready for your acceptance. Server checks run again when accepting."}
        </Text>
      )}
      {Object.values(state.items).map((item) => (
        <WorkCard key={item.id} {...props} state={state} item={item} />
      ))}
      <Action
        theme={theme}
        title="Accept verified result"
        value="accept"
        onAction={onControl}
        disabled={pending || Boolean(problem)}
      />
    </View>
  );
}

const confirmationTitles: Record<Control, string> = {
  pause: "Pause queue",
  resume: "Resume queue",
  accept: "Accept the verified result?",
  stop: "Interrupt all active Cooks?",
  cancel: "Cancel this Kitchen run?",
};
function KitchenControls(
  props: PluginSurfaceProps & {
    state: TeamState;
    confirmation: Control | null;
    pending: boolean;
    onControl(action: Control): void;
    onConfirm(): void;
    onDismiss(): void;
  },
) {
  const { state, theme, confirmation, pending, onControl, onConfirm, onDismiss } = props;
  const styles = useFactoryStyles(props);
  const closed = state.team.status === "done" || state.team.status === "canceled";
  const problem = acceptanceProblem(state);
  const root = state.items[state.team.rootItemId];
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Action
          theme={theme}
          title="Pause queue"
          value="pause"
          onAction={onControl}
          disabled={pending || state.team.status !== "active"}
        />
        <Action
          theme={theme}
          title="Resume queue"
          value="resume"
          onAction={onControl}
          disabled={
            pending || state.team.status !== "paused" || Boolean(state.team.runtime?.limitReason)
          }
        />
        <Action
          theme={theme}
          title="Stop active Cooks"
          value="stop"
          onAction={onControl}
          disabled={pending || closed}
        />
        <Action
          theme={theme}
          title="Cancel Kitchen"
          value="cancel"
          onAction={onControl}
          disabled={pending || closed}
        />
      </View>
      <Text style={styles.muted}>
        Pause prevents new starts; active Cooks continue. Stop interrupts Cooks and allows
        resumption. Cancel closes this run.
      </Text>
      {confirmation ? (
        <View style={styles.card}>
          <Text style={styles.heading}>{confirmation ? confirmationTitles[confirmation] : ""}</Text>
          <Text style={styles.text}>
            {confirmation === "accept"
              ? `Final verified commit: ${String(root?.pack.verifiedCommit || "unavailable")}. Kitchen will recheck HEAD, the clean checkout and all criterion evidence. This records acceptance; merge and deploy require their own authorization.`
              : "New starts will be prevented and active Cooks interrupted."}
          </Text>
          {confirmation === "accept"
            ? root?.acceptanceCriteria.map((criterion) => (
                <Text key={criterion.id} selectable style={styles.text}>
                  {criterion.text} · {criterion.evidence}
                </Text>
              ))
            : null}
          <View style={styles.row}>
            <Action
              theme={theme}
              title="Confirm action"
              value="confirm"
              onAction={onConfirm}
              disabled={pending || (confirmation === "accept" && Boolean(problem))}
            />
            <Action
              theme={theme}
              title="Keep current state"
              value="dismiss"
              onAction={onDismiss}
              disabled={pending}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function AgentPool(
  props: PluginSurfaceProps & {
    state: TeamState;
    workflow?: z.infer<typeof FactoryWorkflowSchema>;
  },
) {
  const { theme, state, workflow } = props;
  const styles = useFactoryStyles(props);
  const [cook, setCook] = useState("");
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Civilization · Boss → work item → Cook</Text>
      {Object.values(state.items).map((item) => (
        <View key={item.id} style={styles.card}>
          <Text style={styles.heading}>
            {item.title} · {item.phase}
          </Text>
          <Text style={styles.muted}>
            {item.parentId
              ? `Managed under ${state.items[item.parentId]?.title || item.parentId}`
              : "Root objective"}
          </Text>
          <View style={styles.branch}>
            {Object.values(state.bindings)
              .filter((binding) => binding.workItemId === item.id)
              .map((binding) => (
                <View key={binding.id} style={styles.stack}>
                  <Text style={styles.text}>
                    {workflow?.roles[binding.role]?.title || binding.role} · {binding.turn} ·{" "}
                    {binding.status}
                  </Text>
                  <Text style={styles.muted}>
                    {binding.profile} · {binding.agentId || "Session starting"} ·{" "}
                    {binding.lastEventAt}
                  </Text>
                  <Action
                    theme={theme}
                    title={`${cook === binding.agentId ? "• " : ""}Read ${binding.role} history`}
                    value={binding.agentId}
                    onAction={setCook}
                    disabled={!binding.agentId}
                  />
                </View>
              ))}
          </View>
        </View>
      ))}
      {cook ? (
        <AgentTimeline key={cook} {...props} agentId={cook} />
      ) : (
        <Text style={styles.muted}>Select a Cook to read its full paginated conversation.</Text>
      )}
    </View>
  );
}

function KitchenMetrics(
  props: PluginSurfaceProps & { state: TeamState; events: TeamEvent[]; detailed?: boolean },
) {
  const styles = useFactoryStyles(props);
  const metrics = kitchenInsights(props.state, props.events);
  const runtime = props.state.team.runtime;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Kitchen status</Text>
      <Text style={styles.text}>
        {metrics.active.length} active Cooks · {metrics.queued.length} queued ·{" "}
        {metrics.completed.length} verified / completed · {metrics.needsYou.length} need your
        attention
      </Text>
      {metrics.needsYou.map((item) => (
        <Text key={item.id} style={styles.danger}>
          {item.title} · {item.phase}
        </Text>
      ))}
      {props.detailed ? (
        <>
          <Text style={styles.text}>
            {metrics.reports} accepted reports · {metrics.rejected} rejected reports ·{" "}
            {metrics.returns} returns
          </Text>
          <Text style={styles.text}>
            {metrics.messages} human messages · {metrics.escalations} escalations
          </Text>
          <Text style={styles.text}>
            Recorded active time:{" "}
            {runtime ? `${Math.round(runtime.usage.activeMs / 60000)} minutes` : "Unavailable"}
          </Text>
          <Text style={styles.text}>
            Observed tokens:{" "}
            {runtime?.usage.tokensAvailable && runtime.usage.observedTokens !== undefined
              ? runtime.usage.observedTokens
              : "Unavailable"}
          </Text>
          <Text style={styles.muted}>
            Cost evidence unavailable. Observed token limits are retrospective, not a prepaid cost
            guarantee.
          </Text>
        </>
      ) : null}
    </View>
  );
}

function KitchenSafety(props: PluginSurfaceProps & { state: TeamState; events: TeamEvent[] }) {
  const styles = useFactoryStyles(props);
  const runtime = props.state.team.runtime;
  const safetyEvents = useMemo(
    () =>
      props.events.filter(
        (event) =>
          event.type.startsWith("safety.") ||
          event.type.startsWith("health.") ||
          event.type === "report.rejected",
      ),
    [props.events],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Safety · accompanied execution</Text>
      <Text style={styles.text}>
        Read-only role instructions do not isolate OS access or credentials. Worktrees isolate
        changes, not processes.
      </Text>
      <Text style={styles.muted}>
        The host can archive or close native agent tabs. Kitchen keeps the run record; this plugin
        does not veto global host archive actions.
      </Text>
      {runtime ? (
        <>
          <Text style={styles.text}>Maximum active Cooks: {runtime.limits.maxActiveCooks}</Text>
          <Text style={styles.text}>
            Role limit: {Math.round(runtime.limits.roleActiveMs / 60000)} active minutes · Run
            limit: {Math.round(runtime.limits.totalActiveMs / 60000)} active minutes ·
            Observed-token threshold: {runtime.limits.observedTokens}
          </Text>
          {!runtime.usage.tokensAvailable ? (
            <Text style={styles.muted}>
              Provider token totals are unavailable on this SDK; the token threshold cannot be
              enforced from those totals.
            </Text>
          ) : null}
          {runtime.limitReason ? <Text style={styles.danger}>{runtime.limitReason}</Text> : null}
        </>
      ) : (
        <Text style={styles.muted}>Runtime limits unavailable for this legacy run.</Text>
      )}
      <EventLog {...props} events={safetyEvents} />
    </View>
  );
}

function EventLog(props: PluginSurfaceProps & { events: TeamEvent[] }) {
  const styles = useFactoryStyles(props);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Recorded events</Text>
      {props.events.length === 0 ? <Text style={styles.muted}>No recorded events.</Text> : null}
      {props.events.map((event) => (
        <View key={event.id} style={styles.card}>
          <Text style={styles.muted}>
            {event.at} · {event.actor.type} · {event.type}
          </Text>
          <Text selectable style={styles.text}>
            {event.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function WorkBoard(
  props: PluginSurfaceProps & {
    state: TeamState;
    workflow?: z.infer<typeof FactoryWorkflowSchema>;
    onRetry(id: string): void;
    pending: boolean;
  },
) {
  const { theme, state, onRetry, pending, workflow } = props;
  const styles = useFactoryStyles(props);
  const phases = Array.from(new Set(Object.values(state.items).map((item) => item.phase)));
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Kitchen · work queue</Text>
      <Text style={styles.muted}>
        Cards are grouped by their actual workflow stage. History shows completed steps;
        dependencies gate execution.
      </Text>
      {workflow
        ? Object.entries(workflow.boards).map(([board, definition]) => (
            <View key={board} style={styles.stack}>
              <Text style={styles.heading}>{board}</Text>
              {Object.entries(definition.phases).map(([phase, details]) => (
                <View key={phase} style={styles.card}>
                  <Text style={styles.heading}>
                    {details.title} · {details.kind}
                  </Text>
                  {details.role ? (
                    <Text style={styles.muted}>
                      {workflow.roles[details.role]?.title || details.role}
                    </Text>
                  ) : null}
                  {Object.values(state.items)
                    .filter((item) => item.board === board && item.phase === phase)
                    .map((item) => (
                      <WorkCard key={item.id} {...props} item={item} />
                    ))}
                </View>
              ))}
            </View>
          ))
        : phases.map((phase) => (
            <View key={phase} style={styles.card}>
              <Text style={styles.heading}>{phase}</Text>
              {Object.values(state.items)
                .filter((item) => item.phase === phase)
                .map((item) => (
                  <WorkCard key={item.id} {...props} item={item} />
                ))}
            </View>
          ))}
      <Text style={styles.heading}>Execution queue</Text>
      {Object.values(state.decisions).map((decision) => (
        <View key={decision.id} style={styles.card}>
          <Text style={styles.text}>
            {state.items[decision.workItemId]?.title || decision.workItemId} · {decision.kind}
          </Text>
          <Text style={styles.muted}>
            {decision.status} · attempt {decision.attempts}
            {decision.status === "retry" ? ` · available ${decision.availableAt}` : ""}
          </Text>
          {decision.lastError ? (
            <Text selectable style={styles.danger}>
              {decision.lastError}
            </Text>
          ) : null}
          {decision.status === "failed" ||
          decision.status === "retry" ||
          (decision.status === "pending" && Date.parse(decision.availableAt) > Date.now()) ? (
            <Action
              theme={theme}
              title="Retry execution"
              value={decision.id}
              onAction={onRetry}
              disabled={pending}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function WorkCard(props: PluginSurfaceProps & { state: TeamState; item: WorkItem }) {
  const { state, item } = props;
  const styles = useFactoryStyles(props);
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{item.title}</Text>
      <Text style={styles.text}>{item.objective}</Text>
      <Text style={styles.muted}>
        Steps: {item.phaseHistory.map((step) => step.phase).join(" → ")}
      </Text>
      {item.dependsOn.map((dependency) => (
        <Text key={dependency.id} style={styles.muted}>
          Depends on {state.items[dependency.id]?.title || dependency.id} reaching{" "}
          {dependency.until}
        </Text>
      ))}
      {item.acceptanceCriteria.map((criterion) => (
        <Text key={criterion.id} style={styles.text}>
          {criterion.met ? "✓" : "○"} {criterion.text}
          {criterion.evidence ? ` · ${criterion.evidence}` : ""}
        </Text>
      ))}
      {item.reports.map((report) => (
        <Text
          key={`${report.role}:${report.phase}:${report.summary}`}
          selectable
          style={styles.text}
        >
          {report.role} · {report.outcome}: {report.summary}
        </Text>
      ))}
      {item.artifacts.map((artifact) => (
        <Text key={`${artifact.kind}:${artifact.ref}`} selectable style={styles.muted}>
          {artifact.kind}: {artifact.ref}
        </Text>
      ))}
    </View>
  );
}
