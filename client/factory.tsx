import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PluginSurfaceProps,
  type PluginAgentPanelProps,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import type { z } from "zod";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import {
  factoryList,
  factoryKitchenStart,
  factoryPacks,
  FactoryPackSchema,
  TEAM_ROLE_LABEL,
  type StartKitchenInput,
  type RoleProfileOverride,
} from "../shared/factory-contracts.js";
import { Action, Field, Disclosure, useFactoryStyles } from "./ui.js";
import { listFactoryAgents } from "./agents.js";
import { missionCriteria, missionName } from "./kitchen-model.js";
import { KitchenSchedules } from "./schedules.js";
import { TargetSelection, useKitchenTarget } from "./target.js";
import { RoleAssignments } from "./workflows.js";
import { Choice } from "./choice.js";
import { PolicyFields, parsePolicyDraft, type PolicyDraft } from "./policy.js";
import { PublicationFields, initialPublication, parsePublication } from "./publication.js";
import { TeamView } from "./team-view.js";
import { readKitchenSuggestion } from "../shared/kitchen-suggestion.js";

const formStyle = { flex: 1, maxWidth: 820, gap: 16 };
const emptyRoles = {};
const workTypeOptions = [
  { id: "feature", title: "Feature" },
  { id: "bug", title: "Bug fix" },
  { id: "maintenance", title: "Maintenance" },
];
const executionOptions = [
  { id: "auto", title: "Automatic · Jev chooses a single agent or team" },
  { id: "team", title: "Team · plan, build, review and verify" },
  { id: "single", title: "Single · implement, review and verify one task" },
];
function schedulesLabel(show: boolean) {
  return show ? "Show Kitchen run" : "Kitchen triggers";
}
const emptyPacks: z.infer<typeof FactoryPackSchema>[] = [];

type Props = PluginSurfaceProps &
  Partial<Pick<PluginAgentPanelProps, "workspaceId" | "agentId">> & {
    projectPath?: string;
    onNew?(): void;
    onCancel?(): void;
    createNew?: boolean;
    selectedTeamId?: string;
    onCreated?(teamId: string): void;
  };

export function Factory(props: Props) {
  const { theme, workspaceId, agentId, onCancel } = props;
  const styles = useFactoryStyles(props);
  const paseo = usePaseo();
  const list = useRpc(factoryList);
  const start = useRpc(factoryKitchenStart);
  const packsRpc = useRpc(factoryPacks);
  const cache = useQueryClient();
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = paseo.agents.subscribe(() => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void cache.invalidateQueries({ queryKey: ["factory"] });
      }, 300);
    });
    return () => {
      unsubscribe();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [paseo, cache]);
  const [showSchedules, setShowSchedules] = useState(false);
  const toggleSchedules = useCallback(() => setShowSchedules((value) => !value), []);
  const [selected, setSelected] = useState(props.selectedTeamId || "");
  const [creating, setCreating] = useState(Boolean(props.createNew));
  const [roleProfiles, setRoleProfiles] = useState<Record<string, RoleProfileOverride>>({});
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [cwd, setCwd] = useState(props.projectPath || "");
  const [source, setSource] = useState(agentId || "");
  useEffect(() => {
    if (props.projectPath) setCwd(props.projectPath);
  }, [props.projectPath]);
  useEffect(() => {
    if (!agentId || !workspaceId || !props.createNew) return;
    let disposed = false;
    void (async () => {
      const handle = paseo.agents.ref(agentId);
      const [result, page] = await Promise.all([
        handle.refresh(),
        handle.timeline.refetch({ limit: 100, direction: "tail" }),
      ]);
      const agent = result?.agent;
      const suggestion = readKitchenSuggestion(
        page.entries.map((entry) => entry.item),
        agentId,
      );
      if (
        disposed ||
        !suggestion ||
        suggestion.workspaceId !== workspaceId ||
        agent?.workspaceId !== workspaceId ||
        agent.cwd !== suggestion.cwd
      )
        return;
      setTitle((value) => value || suggestion.title);
      setObjective((value) => value || suggestion.objective);
      setCwd((value) => value || suggestion.cwd);
      setSource((value) => value || suggestion.sourceAgentId);
    })().catch(() => {});
    return () => {
      disposed = true;
    };
  }, [agentId, workspaceId, props.createNew, paseo]);
  const [kind, setKind] = useState<"feature" | "bug" | "maintenance">("feature");
  const [workflowMode, setWorkflowMode] = useState<"fixed" | "self-organizing">("self-organizing");
  const [publicationDraft, setPublicationDraft] = useState(initialPublication);
  const publication = useMemo(() => parsePublication(publicationDraft), [publicationDraft]);
  const [spec, setSpec] = useState("");
  const missionMode = workflowMode === "self-organizing" ? "goal-driven" : "planned";
  const [executionMode, setExecutionMode] = useState<"auto" | "single" | "team">("auto");
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft>({});
  const policy = useMemo(() => parsePolicyDraft(policyDraft), [policyDraft]);
  const [packId, setPackId] = useState("kitchen");
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const teams = useQuery({
    queryKey: ["factory", "teams"],
    queryFn: () => list({}),
    refetchInterval: 4000,
  });
  const packs = useQuery({ queryKey: ["factory", "packs"], queryFn: () => packsRpc({}) });
  const agents = useQuery({
    queryKey: ["factory", "agents", workspaceId],
    queryFn: () => listFactoryAgents(paseo.agents),
  });
  const workspace = useQuery({
    queryKey: ["factory", "workspace", workspaceId],
    queryFn: () => paseo.workspaces.ref(workspaceId!).refresh(),
    enabled: Boolean(workspaceId),
  });
  const eligible = useMemo(
    () =>
      agents.data?.entries.filter(
        ({ agent }) =>
          !agent.archivedAt &&
          !agent.labels[TEAM_ROLE_LABEL] &&
          (!workspaceId || agent.workspaceId === workspaceId),
      ) || [],
    [agents.data, workspaceId],
  );
  const availablePacks = packs.data?.packs ?? emptyPacks;
  const formPacks = useMemo(
    () =>
      executionMode === "single" ? availablePacks.filter(singleCompatiblePack) : availablePacks,
    [executionMode, availablePacks],
  );
  const sourceAgent = eligible.find(({ agent }) => agent.id === source)?.agent;
  const targetSelection = useKitchenTarget(sourceAgent, targetDirectory(cwd, workspace.data));
  const request = useMemo<Omit<StartKitchenInput, "idempotencyKey">>(
    () => ({
      ...targetSelection.target,
      title: missionName(title, objective),
      objective: objective.trim(),
      acceptanceCriteria: missionCriteria(objective, criteria),
      kind,
      workflowMode,
      missionMode,
      packId,
      roleProfiles,
      spec: optionalText(spec),
      executionMode,
      policy: policyValue(policy),
      publication: resultValue(publication),
    }),
    [
      targetSelection.target,
      title,
      objective,
      criteria,
      kind,
      workflowMode,
      missionMode,
      packId,
      roleProfiles,
      spec,
      executionMode,
      policy,
      publication,
    ],
  );
  const validRequest =
    validSettings(policy.success, publication.success) &&
    validKitchenRequest(targetSelection.valid, request);
  const create = useMutation({
    mutationFn: () => {
      if (!validRequest)
        throw new Error("Add a goal and choose a project with an available agent model.");
      const input = request;
      const fingerprint = JSON.stringify(input);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = {
          fingerprint,
          key: `kitchen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
      return start({ ...input, idempotencyKey: attempt.current.key });
    },
    onSuccess: async (state) => {
      setSelected(state.team.id);
      setCreating(false);
      props.onCreated?.(state.team.id);
      await cache.invalidateQueries({ queryKey: ["factory"] });
    },
  });
  const openRun = useCallback((id: string) => {
    setSelected(id);
    setShowSchedules(false);
    setCreating(false);
  }, []);
  const startKitchen = useCallback(() => create.mutate(), [create]);
  const freshRequest = useCallback(() => {
    attempt.current = null;
    create.reset();
    setTitle("");
    setObjective("");
    setCriteria("");
  }, [create]);
  const cancelMission = useCallback(() => {
    setCreating(false);
    onCancel?.();
  }, [onCancel]);
  const refresh = useCallback(() => {
    void cache.invalidateQueries({ queryKey: ["factory"] });
  }, [cache]);
  const chooseSource = useCallback(
    (id: string) => {
      setSource(id);
      const agent = agents.data?.entries.find((entry) => entry.agent.id === id)?.agent;
      if (agent) setCwd(agent.cwd);
    },
    [agents.data],
  );
  const chooseProject = useCallback((path: string) => {
    setSource("");
    setCwd(path);
  }, []);
  const visibleTeams = (teams.data?.teams || []).filter(
    (state) =>
      (!props.projectPath ||
        state.team.cwd === props.projectPath ||
        state.team.cwd.startsWith(props.projectPath + "/")) &&
      (!workspaceId ||
        state.team.id === selected ||
        eligible.some(({ agent }) => agent.id === state.team.bossAgentId) ||
        state.team.cwd === workspace.data?.workspaceDirectory ||
        state.team.kitchen?.sourceAgentId === agentId),
  );
  const chooseExecution = useCallback((value: string) => {
    setExecutionMode(value === "single" || value === "team" ? value : "auto");
    if (value === "single") setPackId("kitchen");
  }, []);
  const selectionVisible = visibleTeams.some((state) => state.team.id === selected);
  const canShowContent = !creating;
  const error = [teams.error, agents.error, packs.error, workspace.error, create.error].find(
    Boolean,
  );
  return (
    <KeyboardAvoidingView
      behavior={props.layout.platform === "ios" ? "padding" : "height"}
      style={styles.screen}
    >
      <ScrollView
        style={styles.screen}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        <MissionHeading
          {...props}
          creating={creating}
          showSchedules={showSchedules}
          onRefresh={refresh}
          onSchedules={toggleSchedules}
          error={error}
        />
        <View style={creating ? styles.stack : styles.columns}>
          {canShowContent ? (
            <View style={styles.sidebar}>
              <Text style={styles.heading}>Kitchen runs</Text>
              {teams.isPending ? <Text style={styles.muted}>Loading runs…</Text> : null}
              {visibleTeams.map((state) => (
                <Action
                  key={state.team.id}
                  theme={theme}
                  title={`${state.team.title} · ${state.team.status}`}
                  selected={selected === state.team.id}
                  value={state.team.id}
                  onAction={openRun}
                />
              ))}
              {visibleTeams.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.heading}>No missions here yet</Text>
                  <Text style={styles.muted}>
                    Start with an outcome. Kitchen will plan and assign the work.
                  </Text>
                  {props.onNew ? (
                    <Action
                      theme={theme}
                      title="Start mission"
                      variant="primary"
                      value="new"
                      onAction={props.onNew}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
          {creating ? (
            <View style={formStyle}>
              <KitchenStartForm
                {...props}
                roleProfiles={roleProfiles}
                onRoleProfiles={setRoleProfiles}
                title={title}
                objective={objective}
                criteria={criteria}
                cwd={cwd}
                source={source}
                kind={kind}
                workflowMode={workflowMode}
                packId={packId}
                eligible={eligible}
                packs={formPacks}
                loadingAgents={agents.isPending}
                pending={create.isPending}
                success={create.isSuccess}
                validSource={validSettings(
                  targetSelection.valid,
                  policy.success,
                  publication.success,
                )}
                targetSelection={targetSelection}
                onProject={chooseProject}
                onTitle={setTitle}
                onObjective={setObjective}
                onCriteria={setCriteria}
                onCwd={setCwd}
                onSource={chooseSource}
                onKind={setKind}
                onWorkflow={setWorkflowMode}
                onPack={setPackId}
                onStart={startKitchen}
                onFresh={freshRequest}
                executionMode={executionMode}
                onExecution={chooseExecution}
                spec={spec}
                onSpec={setSpec}
                policyDraft={policyDraft}
                onPolicy={setPolicyDraft}
                publicationDraft={publicationDraft}
                onPublication={setPublicationDraft}
              />
            </View>
          ) : null}
          {canShowContent ? (
            <KitchenContent
              {...props}
              selected={selected}
              selectionVisible={Boolean(selectionVisible)}
              showSchedules={showSchedules}
              request={request}
              validRequest={validRequest}
              onOpenRun={openRun}
            />
          ) : null}
        </View>
      </ScrollView>
      {creating ? (
        <MissionStartFooter
          {...props}
          ready={validRequest}
          pending={create.isPending}
          onStart={startKitchen}
          onCancel={cancelMission}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function KitchenStartForm(
  props: Props & {
    roleProfiles: Record<string, RoleProfileOverride>;
    onRoleProfiles(value: Record<string, RoleProfileOverride>): void;
    title: string;
    objective: string;
    criteria: string;
    cwd: string;
    source: string;
    kind: "feature" | "bug" | "maintenance";
    workflowMode: "fixed" | "self-organizing";
    packId: string;
    eligible: Awaited<ReturnType<typeof listFactoryAgents>>["entries"];
    packs: z.infer<typeof FactoryPackSchema>[];
    loadingAgents: boolean;
    pending: boolean;
    success: boolean;
    validSource: boolean;
    targetSelection: ReturnType<typeof useKitchenTarget>;
    onProject(value: string): void;
    onTitle(value: string): void;
    onObjective(value: string): void;
    onCriteria(value: string): void;
    onCwd(value: string): void;
    onSource(value: string): void;
    onKind(value: "feature" | "bug" | "maintenance"): void;
    onWorkflow(value: "fixed" | "self-organizing"): void;
    onPack(value: string): void;
    onStart(): void;
    onFresh(): void;
    executionMode: string;
    onExecution(value: string): void;
    spec: string;
    onSpec(value: string): void;
    policyDraft: PolicyDraft;
    onPolicy(value: PolicyDraft): void;
    publicationDraft: typeof initialPublication;
    onPublication(value: typeof initialPublication): void;
  },
) {
  const {
    theme,
    title,
    objective,
    criteria,
    cwd,
    source,
    kind,
    workflowMode,
    packId,
    eligible,
    packs,
    loadingAgents,
    success,
    validSource,
    targetSelection,
    onProject,
    onTitle,
    onObjective,
    onCriteria,
    onCwd,
    onSource,
    onKind,
    onWorkflow,
    onPack,
    onFresh,
  } = props;
  const styles = useFactoryStyles(props);
  const sourceOptions = useMemo(
    () =>
      eligible.map(({ agent }) => ({
        id: agent.id,
        title: `${agent.title || agent.id} · ${agent.provider}`,
      })),
    [eligible],
  );
  const selectedPack = packs.find((pack) => pack.id === packId);
  const packOptions = useMemo(
    () => packs.map((pack) => ({ id: pack.id, title: pack.title })),
    [packs],
  );
  return (
    <View style={styles.stack}>
      <View style={styles.stack}>
        <Field
          theme={theme}
          label="What should be true when Kitchen is done?"
          value={objective}
          onChange={onObjective}
          placeholder="For example: Customers can sign in and keep their session after reopening the app."
          multiline
          autoFocus
        />
        <Text style={styles.muted}>
          Kitchen plans the work, assigns agents and verifies the result. It asks you when a
          decision is needed.
        </Text>
        <Disclosure
          theme={theme}
          title="Define success"
          summary={
            criteria.trim()
              ? "Custom acceptance criteria"
              : "Optional. Kitchen must verify your goal before you accept the result."
          }
        >
          <Field
            theme={theme}
            label="Observable results, one per line"
            value={criteria}
            onChange={onCriteria}
            multiline
            placeholder="Login survives an app restart
Expired sessions return to sign-in"
          />
        </Disclosure>
      </View>
      {!props.projectPath ? (
        <TargetSelection
          {...props}
          selection={targetSelection}
          hasSource={Boolean(targetSelection.target.sourceAgentId)}
          onProject={onProject}
        />
      ) : null}
      <View style={styles.card}>
        <Text style={styles.heading}>Conversation context</Text>
        <View style={styles.row}>
          {props.agentId ? (
            <Action
              theme={theme}
              title="Current conversation"
              selected={source === props.agentId}
              value={props.agentId}
              onAction={onSource}
              variant="secondary"
            />
          ) : null}
          <Action
            theme={theme}
            title="No conversation"
            selected={!source}
            value=""
            onAction={onSource}
            variant="secondary"
          />
        </View>
        <Choice
          {...props}
          label="Choose another conversation"
          value={source}
          onChange={onSource}
          allowEmpty
          emptyTitle="Start from the goal"
          options={sourceOptions}
        />
        {loadingAgents ? <Text style={styles.muted}>Loading conversations…</Text> : null}
      </View>
      <Disclosure
        theme={theme}
        title="How should it run?"
        summary={
          workflowMode === "self-organizing"
            ? "Continue until the goal is verified. Standard team."
            : "Follow the initial plan. Standard team."
        }
      >
        <View style={styles.row}>
          <Action
            theme={theme}
            title="Until the goal is done"
            selected={workflowMode === "self-organizing"}
            value={"self-organizing" as const}
            onAction={onWorkflow}
            variant="secondary"
          />
          <Action
            theme={theme}
            title="Follow a fixed plan"
            selected={workflowMode === "fixed"}
            value={"fixed" as const}
            onAction={onWorkflow}
            variant="secondary"
          />
        </View>
        <Text style={styles.muted}>
          {workflowMode === "self-organizing"
            ? "Kitchen can request and dispatch additional scoped work when verification finds something missing."
            : "Kitchen plans the initial tasks. Additional work requests are disabled."}
        </Text>
        <Disclosure
          theme={theme}
          title="Customize the team"
          summary="Plan, Build, Review, Verify, Integrate and Final verification are already configured."
        >
          <RoleAssignments
            {...props}
            roles={selectedPack?.roles || selectedPack?.workflow.roles || emptyRoles}
            value={props.roleProfiles}
            onChange={props.onRoleProfiles}
          />
        </Disclosure>
      </Disclosure>
      <Disclosure
        theme={theme}
        title="Advanced options"
        summary="Models, roles, workflow packs, budgets and publishing"
      >
        <Field
          theme={theme}
          label="Mission name (optional)"
          value={title}
          onChange={onTitle}
          placeholder={missionName("", objective) || "Name is taken from the goal"}
        />
        {props.projectPath ? (
          <TargetSelection
            {...props}
            selection={targetSelection}
            hasSource={Boolean(targetSelection.target.sourceAgentId)}
            onProject={onProject}
          />
        ) : null}
        <Field
          theme={theme}
          label="Custom project directory"
          value={cwd}
          onChange={onCwd}
          placeholder="/absolute/path/to/project"
        />
        <Choice
          {...props}
          label="Execution mode"
          value={props.executionMode}
          options={executionOptions}
          onChange={props.onExecution}
        />
        <Field
          theme={theme}
          label="Specification · optional"
          value={props.spec}
          onChange={props.onSpec}
          multiline
          placeholder="Architecture, constraints or additional context"
        />
        <Choice
          {...props}
          label="Work type"
          value={kind}
          options={workTypeOptions}
          onChange={onKind}
        />
        <Choice
          {...props}
          label="Workflow pack"
          value={packId}
          options={packOptions}
          onChange={onPack}
        />
        <PolicyFields {...props} value={props.policyDraft} onChange={props.onPolicy} />
        <Disclosure
          theme={theme}
          title="Pull request publishing"
          summary="Optional. Requires explicit approval after final acceptance."
        >
          <PublicationFields
            {...props}
            value={props.publicationDraft}
            onChange={props.onPublication}
          />
        </Disclosure>
      </Disclosure>
      {!validSource ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          Choose a project with an available model. Check any advanced options you changed.
        </Text>
      ) : null}
      {success ? (
        <Action theme={theme} title="Prepare another mission" value="new" onAction={onFresh} />
      ) : null}
    </View>
  );
}

function validKitchenRequest(
  targetValid: boolean,
  request: Omit<StartKitchenInput, "idempotencyKey">,
) {
  return Boolean(
    targetValid && request.title && request.objective && request.acceptanceCriteria.length,
  );
}

function KitchenContent(
  props: Props & {
    selected: string;
    selectionVisible: boolean;
    showSchedules: boolean;
    request: Omit<StartKitchenInput, "idempotencyKey">;
    validRequest: boolean;
    onOpenRun(id: string): void;
  },
) {
  const { selected, selectionVisible, showSchedules, request, validRequest, onOpenRun } = props;
  const styles = useFactoryStyles(props);
  if (showSchedules)
    return (
      <View style={styles.main}>
        <KitchenSchedules
          {...props}
          target={request}
          validTarget={validRequest}
          onOpenRun={onOpenRun}
        />
      </View>
    );
  return (
    <View style={styles.main}>
      {selected && selectionVisible ? (
        <TeamView key={selected} {...props} teamId={selected} />
      ) : (
        <Text style={styles.muted}>
          Select a mission to inspect its agents, workflow, conversation and acceptance evidence.
          Runs remain here independently of native agent tabs.
        </Text>
      )}
    </View>
  );
}

function optionalText(text: string) {
  return text.trim() || undefined;
}
function policyValue(result: ReturnType<typeof parsePolicyDraft>) {
  return result.success ? result.data : undefined;
}

function targetDirectory(cwd: string, workspace?: { workspaceDirectory?: string | null } | null) {
  return cwd || workspace?.workspaceDirectory || "";
}

function validSettings(...flags: boolean[]) {
  return flags.every(Boolean);
}
function resultValue<T>(result: { success: true; data: T } | { success: false }) {
  return result.success ? result.data : undefined;
}

function singleCompatiblePack(pack: z.infer<typeof FactoryPackSchema>) {
  return pack.id === "kitchen" || pack.id === "kitchen-single";
}

function MissionStartFooter(
  props: Props & { ready: boolean; pending: boolean; onStart(): void; onCancel(): void },
) {
  const styles = useFactoryStyles(props);
  return (
    <View style={styles.footer}>
      <View style={styles.footerActions}>
        <Action
          theme={props.theme}
          title="Cancel"
          variant="secondary"
          value="cancel"
          onAction={props.onCancel}
          disabled={props.pending}
          compact={props.layout.compact}
        />
        <Action
          theme={props.theme}
          variant="primary"
          title={props.pending ? "Starting…" : "Start mission"}
          accessibilityLabel="Start mission"
          value="start"
          onAction={props.onStart}
          disabled={props.pending || !props.ready}
          compact={props.layout.compact}
        />
      </View>
    </View>
  );
}

function MissionHeading(
  props: Props & {
    creating: boolean;
    showSchedules: boolean;
    error?: unknown;
    onRefresh(): void;
    onSchedules(): void;
  },
) {
  const styles = useFactoryStyles(props);
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Text style={styles.title}>{props.creating ? "Start mission" : "Missions"}</Text>
        {!props.creating ? (
          <>
            <Action
              theme={props.theme}
              title="Refresh"
              value="refresh"
              onAction={props.onRefresh}
            />
            <Action
              theme={props.theme}
              title={schedulesLabel(props.showSchedules)}
              value="schedules"
              onAction={props.onSchedules}
            />
          </>
        ) : null}
      </View>
      {!props.creating ? (
        <Text style={styles.muted}>
          Open a mission to answer a question, follow the work or review its verified result.
        </Text>
      ) : null}
      {props.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {String(props.error)}
        </Text>
      ) : null}
    </View>
  );
}
