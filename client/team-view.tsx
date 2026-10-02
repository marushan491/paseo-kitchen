import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import type { z } from "zod";
import { Text, View } from "react-native";
import {
  factoryKitchenControl,
  factoryPublish,
  factoryMessage,
  factoryRetry,
  factoryStatus,
  FactoryWorkflowSchema,
  type TeamState,
  type WorkItem,
  type TeamEvent,
} from "../shared/factory-contracts.js";
import { Action, Field, Disclosure, useFactoryStyles } from "./ui.js";
import { WorkItemProfileSettings } from "./workflows.js";
import { AgentTimeline } from "./timeline.js";
import { acceptanceProblem, kitchenInsights } from "./kitchen-model.js";
import {
  MissionStory,
  MissionEvidence,
  MissionActivityView,
  MissionReply,
} from "./mission-story.js";

import { useMissionAgents } from "./mission-agents.js";

const emptyRoles = {};
const views = ["Stages", "Evidence", "Activity", "Team chat"] as const;
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
  const [view, setView] = useState<(typeof views)[number]>("Stages");
  const replyView = useCallback(() => setView("Team chat"), []);
  const evidenceView = useCallback(() => setView("Evidence"), []);
  const [credential, setCredential] = useState("");
  const [confirmation, setConfirmation] = useState<Control | null>(null);
  const team = useQuery({
    queryKey: ["factory", "team", teamId],
    queryFn: () => read({ teamId }),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
  const live = useMissionAgents(team.data?.state, props.host.id);
  const change = useMutation({
    mutationFn: async (action: Control | { retry: string }) => {
      if (typeof action === "object")
        await retry({ teamId, decisionId: action.retry, actorId: "human" });
      else
        await controlRpc({
          teamId,
          action,
          actorId: "human",
          ...(action === "accept"
            ? { credential, candidateCommit: verifiedCandidate(team.data?.state) }
            : {}),
        });
    },
    gcTime: 0,
    onSettled: () => setCredential(""),
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
  const dismiss = useCallback(() => {
    setConfirmation(null);
    setCredential("");
  }, []);
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
      <MissionHeader
        {...props}
        state={state}
        pending={change.isPending}
        onControl={control}
        onOpenAgent={openAgent}
      />
      {team.error || change.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {String(team.error || change.error)}
        </Text>
      ) : null}
      {confirmation ? (
        <KitchenControls
          {...props}
          state={state}
          confirmation={confirmation}
          pending={change.isPending}
          onControl={control}
          onConfirm={confirm}
          onDismiss={dismiss}
          credential={credential}
          onCredential={setCredential}
          onlyConfirmation
        />
      ) : null}
      <View style={styles.row}>
        {views.map((name) => (
          <Action
            key={name}
            theme={theme}
            title={name}
            selected={name === view}
            value={name}
            onAction={setView}
          />
        ))}
      </View>
      {view === "Team chat" ? (
        <View style={styles.stack}>
          <MissionReply {...props} state={state} canSend={!closed} onSend={sendToBoss} />
          <Disclosure theme={theme} title="Full Head Chef conversation">
            <AgentTimeline
              key={state.team.bossAgentId}
              {...props}
              agentId={state.team.bossAgentId}
            />
          </Disclosure>
        </View>
      ) : null}
      {view === "Stages" ? (
        <MissionStory
          {...props}
          state={state}
          workflow={workflow}
          agents={live.agents}
          onReply={replyView}
          onEvidence={evidenceView}
        />
      ) : null}
      {view === "Evidence" ? (
        <View style={styles.stack}>
          <MissionEvidence {...props} state={state} />
          <KitchenVerification
            {...props}
            state={state}
            onControl={control}
            pending={change.isPending}
          />
          <Publication {...props} state={state} />
        </View>
      ) : null}
      {view === "Activity" ? (
        <MissionActivityView {...props} state={state} workflow={workflow} events={events} />
      ) : null}
      {live.error ? (
        <Text style={styles.muted}>Agent activity is unavailable: {String(live.error)}</Text>
      ) : null}
      <Disclosure
        theme={theme}
        title="Technical details"
        summary="Runtime controls, task records, role settings and the complete event history"
      >
        <Text selectable style={styles.muted}>
          {state.team.packId} / revision {state.commit} / {state.team.cwd}
        </Text>
        <KitchenControls
          {...props}
          state={state}
          confirmation={null}
          pending={change.isPending}
          onControl={control}
          onConfirm={confirm}
          onDismiss={dismiss}
          credential={credential}
          onCredential={setCredential}
        />
        <KitchenMetrics {...props} state={state} events={events} detailed />
        <WorkBoard
          {...props}
          state={state}
          workflow={workflow}
          onRetry={retryDecision}
          pending={change.isPending || closed}
        />
        {Object.values(state.items).map((item) => (
          <WorkItemProfileSettings
            key={item.id}
            {...props}
            state={state}
            workItemId={item.id}
            roles={workflow?.roles || emptyRoles}
          />
        ))}
        <AgentPool {...props} state={state} workflow={workflow} />
        <KitchenSafety {...props} state={state} events={events} />
        <EventLog {...props} events={events} />
      </Disclosure>
    </View>
  );
}

function MissionHeader(
  props: PluginSurfaceProps & {
    state: TeamState;
    pending: boolean;
    onControl(action: Control): void;
    onOpenAgent(id: string): void;
  },
) {
  const { state, theme, navigation, pending, onControl, onOpenAgent } = props;
  const styles = useFactoryStyles(props);
  const closed = state.team.status === "done" || state.team.status === "canceled";
  return (
    <View style={styles.stack}>
      <Text style={styles.title}>{state.team.title}</Text>
      <Text style={styles.text}>{state.team.objective}</Text>
      <Text style={styles.muted}>
        {state.team.kitchen?.missionMode === "goal-driven"
          ? "Goal-driven · discovering and completing scoped work until the goal is verified."
          : "Planned mission · following the agreed tasks."}
      </Text>
      <View style={styles.row}>
        <Action
          theme={theme}
          title={state.team.status === "paused" ? "Resume mission" : "Pause new work"}
          value={state.team.status === "paused" ? ("resume" as const) : ("pause" as const)}
          onAction={onControl}
          disabled={closed || pending || Boolean(state.team.runtime?.limitReason)}
        />
        <Action
          theme={theme}
          title="Open Head Chef"
          value={state.team.bossAgentId}
          onAction={onOpenAgent}
          disabled={!navigation}
        />
        {state.team.kitchen?.sourceAgentId ? (
          <Action
            theme={theme}
            title="Open source session"
            value={state.team.kitchen.sourceAgentId}
            onAction={onOpenAgent}
            disabled={!navigation}
          />
        ) : null}
      </View>
      {state.team.pausedReason ? (
        <Text style={styles.danger}>{state.team.pausedReason}</Text>
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
    credential: string;
    onCredential(value: string): void;
    onlyConfirmation?: boolean;
  },
) {
  const { state, theme, confirmation, pending, onControl, onConfirm, onDismiss } = props;
  const styles = useFactoryStyles(props);
  const closed = state.team.status === "done" || state.team.status === "canceled";
  const problem = acceptanceProblem(state);
  const root = state.items[state.team.rootItemId];
  return (
    <View style={styles.stack}>
      {!props.onlyConfirmation ? (
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
      ) : null}
      {!props.onlyConfirmation ? (
        <Text style={styles.muted}>
          Pause prevents new starts; active Cooks continue. Stop interrupts Cooks and allows
          resumption. Cancel closes this run.
        </Text>
      ) : null}
      {confirmation ? (
        <View style={styles.card}>
          <Text style={styles.heading}>{confirmationTitles[confirmation]}</Text>
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
          {confirmation === "accept" ? (
            <>
              <Field
                theme={theme}
                label="Operator credential · used only for this approval"
                secureTextEntry
                value={props.credential}
                onChange={props.onCredential}
              />
              <Text style={styles.muted}>
                Approval proves possession of the configured plugin credential, not a verified human
                identity. The server rechecks this candidate commit.
              </Text>
            </>
          ) : null}
          <View style={styles.row}>
            <Action
              theme={theme}
              title="Confirm action"
              value="confirm"
              onAction={onConfirm}
              disabled={
                pending ||
                (confirmation === "accept" && (Boolean(problem) || !props.credential.trim()))
              }
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
            Role budget:{" "}
            {runtime.limits.roleActiveMs
              ? Math.round(runtime.limits.roleActiveMs / 60000) + " active minutes"
              : "No limit"}{" "}
            · Total budget:{" "}
            {runtime.limits.totalActiveMs
              ? Math.round(runtime.limits.totalActiveMs / 60000) + " active minutes"
              : "No limit"}{" "}
            · Token budget: {runtime.limits.observedTokens ?? "No limit"}
          </Text>
          {!runtime.usage.tokensAvailable ? (
            <Text style={styles.muted}>
              Observed provider token totals are unavailable. A selected token or money budget
              requires a complete trusted ledger before further paid starts.
            </Text>
          ) : null}
          {runtime.limitReason ? <Text style={styles.danger}>{runtime.limitReason}</Text> : null}
        </>
      ) : (
        <Text style={styles.muted}>Runtime limits unavailable for this legacy run.</Text>
      )}
      {props.state.team.kitchen?.classification ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Recorded execution classification</Text>
          <Text style={styles.text}>
            {props.state.team.kitchen.classification.executionMode} ·{" "}
            {props.state.team.kitchen.classification.reason}
          </Text>
          <Text style={styles.muted}>
            {props.state.team.kitchen.classification.source} ·{" "}
            {props.state.team.kitchen.classification.model} · confidence{" "}
            {props.state.team.kitchen.classification.confidence} ·{" "}
            {props.state.team.kitchen.classification.latencyMs} ms
          </Text>
        </View>
      ) : null}
      <Text style={styles.heading}>Recorded mission policy</Text>
      {props.state.team.policy ? (
        Object.entries(props.state.team.policy).map(([name, value]) => (
          <Text key={name} style={styles.text}>
            {name}: {value}
          </Text>
        ))
      ) : (
        <Text style={styles.muted}>No additional mission policy selected.</Text>
      )}
      <Text style={styles.heading}>Trusted evidence checks</Text>
      {Object.values(props.state.items).every((item) => !item.checks?.length) ? (
        <Text style={styles.muted}>No trusted evidence checks recorded for this run.</Text>
      ) : null}
      {Object.values(props.state.items).flatMap((item) =>
        (item.checks || []).map((check) => (
          <View key={`${item.id}:${check.id}:${check.checkedAt}`} style={styles.card}>
            <Text style={styles.text}>
              {item.title} · {check.kind} · {check.passed ? "passed" : "failed"}
            </Text>
            <Text selectable style={styles.text}>
              {check.summary}
            </Text>
            <Text selectable style={styles.muted}>
              {check.checkedAt} · candidate {check.candidateCommit || "not recorded"}
            </Text>
            {check.artifactSha256 ? (
              <Text selectable style={styles.muted}>
                Artifact SHA256: {check.artifactSha256}
              </Text>
            ) : null}
          </View>
        )),
      )}
      <Text style={styles.muted}>
        Check definitions come from trusted server configuration. This view cannot supply commands
        or modify protected-file checks.
      </Text>
      <Publication {...props} />
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

function Publication(props: PluginSurfaceProps & { state: TeamState }) {
  const styles = useFactoryStyles(props);
  const publish = useRpc(factoryPublish);
  const cache = useQueryClient();
  const [credential, setCredential] = useState("");
  const state = props.state;
  const commit = state.team.kitchen?.acceptedCommit;
  const change = useMutation({
    gcTime: 0,
    mutationFn: () => {
      if (!commit) throw new Error("An accepted candidate commit is required.");
      return publish({ teamId: state.team.id, credential, candidateCommit: commit });
    },
    onSettled: () => setCredential(""),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["factory"] });
    },
  });
  const submit = useCallback(() => change.mutate(), [change]);
  if (!state.team.kitchen?.publication?.enabled) return null;
  if (state.team.kitchen.published)
    return (
      <Text selectable style={styles.text}>
        Published {state.team.kitchen.published.commit}: {state.team.kitchen.published.url}
      </Text>
    );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Publish accepted result</Text>
      <Text style={styles.muted}>
        Explicitly push the accepted commit and create its pull request using the trusted host
        configuration. This does not merge or deploy.
      </Text>
      <Text selectable style={styles.text}>
        {state.team.kitchen.publication.remote} · {state.team.kitchen.publication.branch} →{" "}
        {state.team.kitchen.publication.baseBranch}
      </Text>
      <Field
        theme={props.theme}
        label="Operator credential · publication"
        secureTextEntry
        value={credential}
        onChange={setCredential}
      />
      <Action
        theme={props.theme}
        title="Publish accepted commit and open pull request"
        variant="primary"
        value="publish"
        onAction={submit}
        disabled={state.team.status !== "done" || !commit || !credential.trim() || change.isPending}
      />
      {change.error ? <Text style={styles.danger}>{String(change.error)}</Text> : null}
    </View>
  );
}

function verifiedCandidate(state?: TeamState): string | undefined {
  const commit = state?.items[state.team.rootItemId]?.pack.verifiedCommit;
  return typeof commit === "string" ? commit : undefined;
}
