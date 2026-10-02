import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PluginSurfaceProps,
  type PluginAgentPanelProps,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import type { z } from "zod";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  factoryList,
  factoryKitchenStart,
  factoryPacks,
  FactoryPackSchema,
  TEAM_ROLE_LABEL,
  type StartKitchenInput,
  type RoleProfileOverride,
} from "../shared/factory-contracts.js";
import { Action, Field, useFactoryStyles } from "./ui.js";
import { listFactoryAgents } from "./agents.js";
import { parseCriteria } from "./kitchen-model.js";
import { KitchenSchedules } from "./schedules.js";
import { TargetSelection, useKitchenTarget } from "./target.js";
import { RoleAssignments } from "./workflows.js";
import { Choice } from "./choice.js";
import { PolicyFields, parsePolicyDraft, type PolicyDraft } from "./policy.js";
import { PublicationFields, initialPublication, parsePublication } from "./publication.js";
import { TeamView } from "./team-view.js";

const formStyle = { flex: 1, maxWidth: 820, gap: 16 };
const emptyRoles = {};
const executionOptions = [
  { id: "auto", title: "Auto · classify with the configured decision provider" },
  { id: "team", title: "Team · planning and bounded delegation" },
  { id: "single", title: "Single · implement, review and verify one task" },
];
function schedulesLabel(show: boolean) {
  return show ? "Show Kitchen run" : "Kitchen triggers";
}
const emptyPacks: z.infer<typeof FactoryPackSchema>[] = [];

type Props = PluginSurfaceProps &
  Partial<Pick<PluginAgentPanelProps, "workspaceId" | "agentId">> & {
    createNew?: boolean;
    selectedTeamId?: string;
    onCreated?(teamId: string): void;
  };

export function Factory(props: Props) {
  const { theme, workspaceId, agentId } = props;
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
  const [cwd, setCwd] = useState("");
  const [source, setSource] = useState(agentId || "");
  const [kind, setKind] = useState<"feature" | "bug" | "maintenance">("feature");
  const [workflowMode, setWorkflowMode] = useState<"fixed" | "self-organizing">("fixed");
  const [publicationDraft, setPublicationDraft] = useState(initialPublication);
  const publication = useMemo(() => parsePublication(publicationDraft), [publicationDraft]);
  const [spec, setSpec] = useState("");
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
      title: title.trim(),
      objective: objective.trim(),
      acceptanceCriteria: parseCriteria(criteria),
      kind,
      workflowMode,
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
        throw new Error(
          "Provide a goal, criteria and an available source session or provider/model/project.",
        );
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
  const visibleTeams = teams.data?.teams.filter(
    (state) =>
      !workspaceId ||
      state.team.id === selected ||
      eligible.some(({ agent }) => agent.id === state.team.bossAgentId) ||
      state.team.cwd === workspace.data?.workspaceDirectory ||
      state.team.kitchen?.sourceAgentId === agentId,
  );
  const chooseExecution = useCallback((value: string) => {
    setExecutionMode(value === "single" || value === "team" ? value : "auto");
    if (value === "single") setPackId("kitchen");
  }, []);
  const selectionVisible = visibleTeams?.some((state) => state.team.id === selected);
  const canShowContent = !creating;
  const error = [teams.error, agents.error, packs.error, workspace.error, create.error].find(
    Boolean,
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text style={styles.title}>Missions</Text>
        <Action theme={theme} title="Refresh Kitchen" value="refresh" onAction={refresh} />
        <Action
          theme={theme}
          title={schedulesLabel(showSchedules)}
          value="triggers"
          onAction={toggleSchedules}
        />
      </View>
      <Text style={styles.muted}>
        Give the Team Agent one goal. Follow its Cooks, inspect the verified result and accept it
        yourself.
      </Text>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {String(error)}
        </Text>
      ) : null}
      <View style={creating ? styles.stack : styles.columns}>
        {canShowContent ? (
          <View style={styles.sidebar}>
            <Text style={styles.heading}>Kitchen runs</Text>
            {teams.isPending ? <Text style={styles.muted}>Loading runs…</Text> : null}
            {visibleTeams?.map((state) => (
              <Action
                key={state.team.id}
                theme={theme}
                title={`${state.team.title} · ${state.team.status}`}
                selected={selected === state.team.id}
                value={state.team.id}
                onAction={openRun}
              />
            ))}
            {visibleTeams?.length === 0 ? (
              <Text style={styles.muted}>No runs for this project yet.</Text>
            ) : null}
          </View>
        ) : null}
        {creating ? (
          <View style={formStyle}>
            <Field
              theme={theme}
              label="Specification · optional"
              value={spec}
              onChange={setSpec}
              multiline
            />
            <Choice
              {...props}
              label="Execution mode"
              value={executionMode}
              options={executionOptions}
              onChange={chooseExecution}
            />
            <PolicyFields {...props} value={policyDraft} onChange={setPolicyDraft} />
            <PublicationFields {...props} value={publicationDraft} onChange={setPublicationDraft} />
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
    pending,
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
    onStart,
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
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>New mission</Text>
      <Field theme={theme} label="Job title" value={title} onChange={onTitle} />
      <Field
        theme={theme}
        label="Goal and constraints"
        value={objective}
        onChange={onObjective}
        multiline
      />
      <Field
        theme={theme}
        label="Acceptance criteria · one per line"
        value={criteria}
        onChange={onCriteria}
        multiline
      />
      <Choice
        {...props}
        label="Source session · optional"
        value={source}
        onChange={onSource}
        allowEmpty
        emptyTitle="Start without source session"
        options={sourceOptions}
      />
      {!loadingAgents && eligible.length === 0 ? (
        <Text style={styles.muted}>
          Choose a provider and project below to start without a source session.
        </Text>
      ) : null}
      <TargetSelection
        {...props}
        selection={targetSelection}
        hasSource={Boolean(targetSelection.target.sourceAgentId)}
        onProject={onProject}
      />
      <Field
        theme={theme}
        label="Project directory · defaults to source session"
        value={cwd}
        onChange={onCwd}
      />
      <Text style={styles.muted}>Job kind</Text>
      <View style={styles.row}>
        {(["feature", "bug", "maintenance"] as const).map((value) => (
          <Action
            key={value}
            theme={theme}
            title={`${kind === value ? "✓ " : ""}${value}`}
            value={value}
            onAction={onKind}
          />
        ))}
      </View>
      <Text style={styles.muted}>Workflow</Text>
      <View style={styles.row}>
        {(["fixed", "self-organizing"] as const).map((value) => (
          <Action
            key={value}
            theme={theme}
            title={`${workflowMode === value ? "✓ " : ""}${value}`}
            value={value}
            onAction={onWorkflow}
          />
        ))}
      </View>
      {workflowMode === "self-organizing" ? (
        <Text style={styles.muted}>
          Bounded child requests: depth {selectedPack?.maxDelegationDepth ?? "not declared"}, items{" "}
          {selectedPack?.maxDelegatedItems ?? "not declared"}.
        </Text>
      ) : null}
      <Text style={styles.muted}>Workflow pack</Text>
      {packs.map((pack) => (
        <Action
          key={pack.id}
          theme={theme}
          title={`${pack.id === packId ? "✓ " : ""}${pack.title} · v${pack.version}`}
          value={pack.id}
          onAction={onPack}
        />
      ))}
      <RoleAssignments
        {...props}
        roles={selectedPack?.roles || selectedPack?.workflow.roles || emptyRoles}
        value={props.roleProfiles}
        onChange={props.onRoleProfiles}
      />
      <Action
        theme={theme}
        variant="primary"
        title={pending ? "Starting Kitchen…" : "Start Kitchen"}
        value="start"
        onAction={onStart}
        disabled={
          pending ||
          !title.trim() ||
          !objective.trim() ||
          parseCriteria(criteria).length === 0 ||
          !validSource ||
          !selectedPack
        }
      />
      {success ? (
        <Action theme={theme} title="Prepare another job" value="new" onAction={onFresh} />
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
