import type { PaseoAgent } from "@getpaseo/client";
import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Binding, TeamEvent, TeamState } from "../shared/factory-contracts.js";
import {
  missionAge,
  missionSummary,
  type MissionStage,
  type MissionWorkflow,
} from "../shared/mission-stage.js";
import { missionActivity } from "../shared/mission-story.js";
import { kitchenHumanRequests } from "../shared/dashboard/kitchen-scope.js";
import { Action, Disclosure, Field, useFactoryStyles } from "./ui.js";
import { missionStageColor, missionStageLabels } from "./mission-summary.js";
import { factoryQuestionActivity } from "../shared/question-contracts.js";
import { readHumanQuestion } from "../shared/question-policy.js";
import { factorySettings } from "../shared/preferences.js";

export function MissionStory(
  props: PluginSurfaceProps & {
    state: TeamState;
    workflow?: MissionWorkflow;
    agents: Readonly<Record<string, PaseoAgent>>;
    onReply(): void;
    onEvidence(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const summary = missionSummary(props.state, props.workflow, props.agents);
  const [selected, setSelected] = useState("");
  const requests = kitchenHumanRequests([props.state]);
  return (
    <View style={styles.stack}>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.heading}>{summary.statusLabel}</Text>
          <Text style={styles.muted}>{summary.currentStage}</Text>
        </View>
        <Text style={styles.text}>
          {props.workflow
            ? `${summary.completedItems} / ${summary.totalItems} tasks complete`
            : "Progress unavailable until this workflow is loaded"}
        </Text>
        <Text style={styles.muted}>
          {summary.unobservedCount
            ? "Activity unavailable"
            : `${summary.workingCount} agents working`}{" "}
          / Age {missionAge(summary.ageMs)}
        </Text>
        {summary.unobservedCount ? (
          <Text style={styles.muted}>Some agent activity has not been observed.</Text>
        ) : null}
      </View>
      {summary.stages.length ? (
        <View style={styles.stack}>
          {summary.stages.map((stage) => (
            <StoryStage
              key={stage.id}
              {...props}
              stage={stage}
              selected={stage.id === selected}
              onSelect={setSelected}
            />
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>
          The selected workflow’s stages are unavailable. Mission records remain accessible in
          Technical details.
        </Text>
      )}
      {requests.length ? (
        <View style={styles.stack}>
          <Text style={styles.heading}>Needs you</Text>
          {requests.map((request) => (
            <View key={request.id} style={styles.card}>
              <Text style={styles.heading}>
                {request.ready ? "Ready for acceptance" : request.item.title}
              </Text>
              <Text style={styles.text}>{request.reason}</Text>
              <Action
                theme={props.theme}
                title={request.ready ? "Review result" : "Answer in Team chat"}
                value={null}
                onAction={request.ready ? props.onEvidence : props.onReply}
                variant="primary"
              />
            </View>
          ))}
        </View>
      ) : null}
      {summary.problem ? <Text style={styles.danger}>{summary.problem}</Text> : null}
    </View>
  );
}

function StoryStage(
  props: PluginSurfaceProps & {
    state: TeamState;
    workflow?: MissionWorkflow;
    agents: Readonly<Record<string, PaseoAgent>>;
    stage: MissionStage;
    selected: boolean;
    onSelect(id: string): void;
  },
) {
  const styles = useFactoryStyles(props);
  const { stage, onSelect } = props;
  const select = useCallback(() => onSelect(stage.id), [onSelect, stage.id]);
  const accessibilityState = useMemo(() => ({ expanded: props.selected }), [props.selected]);
  const tone = missionStageColor(props.theme, stage.status);
  const statusStyle = useMemo(() => [styles.muted, { color: tone }], [styles.muted, tone]);
  const bindings = Object.values(props.state.bindings).filter(
    (binding) =>
      stage.agentIds.includes(binding.agentId) &&
      binding.phase === stage.phase &&
      props.state.items[binding.workItemId]?.board === stage.board,
  );
  const current = bindings.filter((binding) => binding.status === "active");
  const shown = current.length ? current : bindings.slice(-1);
  return (
    <View style={styles.card}>
      <Pressable
        onPress={select}
        accessibilityRole="button"
        accessibilityLabel={`${stage.title}: ${missionStageLabels[stage.status]}`}
        accessibilityState={accessibilityState}
      >
        <View style={styles.header}>
          <Text style={styles.heading}>{stage.title}</Text>
          <Text style={statusStyle}>{missionStageLabels[stage.status]}</Text>
        </View>
        {stage.totalCount ? (
          <Text style={styles.muted}>
            {stage.completedCount} / {stage.totalCount} tasks completed
            {stage.skippedCount ? ` · ${stage.skippedCount} skipped (no matching changes)` : ""}
          </Text>
        ) : null}
      </Pressable>
      {props.selected ? (
        <View style={styles.stack}>
          {stage.itemIds.map((id) => (
            <Text key={id} style={styles.text}>
              {props.state.items[id].title}
            </Text>
          ))}
          {shown.map((binding) => (
            <StageAgent key={binding.id} {...props} binding={binding} />
          ))}
          {!shown.length ? (
            <Text style={styles.muted}>
              {stage.status === "skipped"
                ? "No agent ran: no matching changed files."
                : "An agent will be assigned when this stage is ready."}
            </Text>
          ) : null}
          {props.workflow?.roles[stage.role]?.instructions ? (
            <Disclosure theme={props.theme} title="Role instructions">
              <Text style={styles.text}>{props.workflow.roles[stage.role].instructions}</Text>
            </Disclosure>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function StageAgent(
  props: PluginSurfaceProps & {
    state: TeamState;
    agents: Readonly<Record<string, PaseoAgent>>;
    binding: Binding;
    workflow?: MissionWorkflow;
  },
) {
  const styles = useFactoryStyles(props);
  const { binding, navigation } = props;
  const agent = props.agents[binding.agentId];
  const open = useCallback(
    () => navigation?.openAgent({ agentId: binding.agentId }),
    [navigation, binding.agentId],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.text}>
        {agent?.title || props.workflow?.roles[binding.role]?.title || binding.role}
      </Text>
      <Text style={styles.muted}>
        {agent
          ? `${agent.provider} / ${agent.model || "Model unavailable"}`
          : "Provider and model have not been observed"}
      </Text>
      <Text style={styles.muted}>
        {binding.activeMs === undefined
          ? "Active time unavailable"
          : `Recorded active time ${missionAge(binding.activeMs)}`}
      </Text>
      <Action
        theme={props.theme}
        title="Open agent conversation"
        value={null}
        onAction={open}
        disabled={!navigation}
      />
    </View>
  );
}

export function MissionEvidence(props: PluginSurfaceProps & { state: TeamState }) {
  const styles = useFactoryStyles(props);
  const root = props.state.items[props.state.team.rootItemId];
  const checks = Object.values(props.state.items).flatMap((item) =>
    (item.checks ?? []).map((check) => ({ item, check })),
  );
  const artifacts = Object.values(props.state.items).flatMap((item) =>
    item.artifacts.map((artifact) => ({ item, artifact })),
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Done when</Text>
      {root?.acceptanceCriteria.map((criterion) => (
        <View key={criterion.id} style={styles.card}>
          <Text style={styles.text}>{criterion.text}</Text>
          <Text style={styles.muted}>
            {criterion.met ? "Met in the verifier report" : "Awaiting verification"}
          </Text>
          {criterion.evidence ? (
            <Text selectable style={styles.text}>
              {criterion.evidence}
            </Text>
          ) : null}
        </View>
      ))}
      {!root?.acceptanceCriteria.length ? (
        <Text style={styles.muted}>No success criteria were recorded for this mission.</Text>
      ) : null}
      {checks.length ? (
        <View style={styles.stack}>
          <Text style={styles.heading}>Recorded checks</Text>
          {checks.map(({ item, check }) => (
            <View key={`${item.id}:${check.id}:${check.checkedAt}`} style={styles.card}>
              <Text style={styles.heading}>
                {check.passed ? "Passed" : "Failed"} /{" "}
                {check.kind === "browser-artifact" ? "Browser evidence" : check.kind}
              </Text>
              <Text selectable style={styles.text}>
                {check.summary}
              </Text>
              <Text style={styles.muted}>
                {item.title} / {new Date(check.checkedAt).toLocaleString()}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>
          Command and browser checks appear here when the runtime records them.
        </Text>
      )}
      {artifacts.length ? (
        <View style={styles.stack}>
          <Text style={styles.heading}>Result references</Text>
          {artifacts.map(({ item, artifact }) => (
            <View key={`${item.id}:${artifact.kind}:${artifact.ref}`} style={styles.card}>
              <Text style={styles.text}>{artifact.note || artifact.kind}</Text>
              <Text selectable style={styles.muted}>
                {artifact.ref}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function MissionActivityView(
  props: PluginSurfaceProps & {
    state: TeamState;
    events: readonly TeamEvent[];
    workflow?: MissionWorkflow;
  },
) {
  const styles = useFactoryStyles(props);
  const entries = missionActivity(props.state, props.events, props.workflow);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Recent activity</Text>
      {entries.map((entry) => (
        <View key={entry.id} style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.heading}>{entry.title}</Text>
            <Text style={styles.muted}>
              {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
          </View>
          <Text selectable style={styles.text}>
            {entry.description}
          </Text>
        </View>
      ))}
      {!entries.length ? (
        <Text style={styles.muted}>
          Kitchen will record planning, handoffs, verification and your decisions here.
        </Text>
      ) : null}
    </View>
  );
}

export function MissionReply(
  props: PluginSurfaceProps & {
    state: TeamState;
    canSend: boolean;
    onSend(text: string): Promise<void>;
  },
) {
  const styles = useFactoryStyles(props);
  const [text, setText] = useState("");
  const [activityError, setActivityError] = useState(false);
  const cache = useQueryClient();
  const activityRpc = useRpc(factoryQuestionActivity);
  const settings = useSettings(factorySettings);
  const waitsForAnswer =
    settings.status !== "ready" || settings.values.optionalQuestionBehavior === "wait";
  const started = useRef(new Set<string>());
  const questions = kitchenHumanRequests([props.state]).filter((request) => !request.ready);
  const beginReply = useCallback(() => {
    const pending = Object.values(props.state.items)
      .flatMap((item) =>
        Object.values((item.pack.providerHumanQuestions ?? {}) as Record<string, unknown>).concat([
          item.pack.nativeHumanQuestion,
        ]),
      )
      .map(readHumanQuestion)
      .filter((question) => question?.continueAt && !question.responseStartedAt);
    const key = pending
      .map((question) => question!.id)
      .sort()
      .join(",");
    if (!key || started.current.has(key)) return;
    started.current.add(key);
    void activityRpc({ teamId: props.state.team.id, kind: "focus" })
      .then(() => {
        setActivityError(false);
        return cache.invalidateQueries({ queryKey: ["factory"] });
      })
      .catch(() => {
        started.current.delete(key);
        setActivityError(true);
      });
  }, [activityRpc, cache, props.state.team.id, props.state.items]);
  const changeText = useCallback(
    (value: string) => {
      beginReply();
      setText(value);
    },
    [beginReply],
  );
  const send = useMutation({
    mutationFn: props.onSend,
    onSuccess: async (_result, sent) => {
      setText((current) => (current.trim() === sent ? "" : current));
      await cache.invalidateQueries({ queryKey: ["factory"] });
    },
  });
  const submit = useCallback(() => send.mutate(text.trim()), [send, text]);
  return (
    <View style={styles.stack}>
      {questions.map((request) => (
        <View key={request.id} style={styles.card}>
          <Text style={styles.heading}>{request.item.title}</Text>
          <Text selectable style={styles.text}>
            {request.reason}
          </Text>
          {readHumanQuestion(request.item.pack.nativeHumanQuestion)?.continueAt ? (
            <Text style={styles.muted}>
              {questionReplyStatus(request.item.pack.nativeHumanQuestion, waitsForAnswer)}
            </Text>
          ) : null}
        </View>
      ))}
      <Text style={styles.muted}>
        Your answer is saved with this mission and sent to the Head Chef.
      </Text>
      <Field
        theme={props.theme}
        label="Message to Head Chef"
        value={text}
        onChange={changeText}
        onFocus={beginReply}
        multiline
        placeholder="Answer the question or clarify the desired outcome…"
      />
      <Action
        theme={props.theme}
        title={send.isPending ? "Sending…" : "Send to Head Chef"}
        value={null}
        onAction={submit}
        variant="primary"
        disabled={!props.canSend || !text.trim() || send.isPending}
      />
      {send.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {String(send.error)}
        </Text>
      ) : null}
      {activityError ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          Your reply draft could not be synced. Reconnect or send your answer to hold this question.
        </Text>
      ) : null}
      {!props.canSend ? <Text style={styles.muted}>This mission is closed.</Text> : null}
    </View>
  );
}

function questionReplyStatus(value: unknown, waitsForAnswer: boolean) {
  if (readHumanQuestion(value)?.responseStartedAt)
    return "Your reply is in progress; Kitchen is waiting for you.";
  if (waitsForAnswer) return "Kitchen is waiting for your answer.";
  return "Kitchen will continue investigating after the waiting period. Start replying to hold this question.";
}
