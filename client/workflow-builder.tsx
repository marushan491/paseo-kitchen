import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  factoryWorkflowApply,
  factoryWorkflowPreview,
  factoryWorkflowSave,
  factoryWorkflowsList,
  type WorkflowDefinition,
  type WorkflowPreview,
} from "../shared/workflow-contracts.js";
import { factoryPacks, type RoleProfileOverride } from "../shared/factory-contracts.js";
import type { RoleWorkflow } from "../shared/role-builder.js";
import { Choice } from "./choice.js";
import { RoleGraph } from "./role-graph.js";
import { RuntimeProfile } from "./runtime-profile.js";
import { Action, Disclosure, Field, SurfaceSheet, useFactoryStyles } from "./ui.js";

const emptyProfile: RoleProfileOverride = {};
const noRoleSelection = () => {};
const defaultAutonomy = {
  architecture: "human" as const,
  requirements: "human" as const,
  irreversibleActions: "human" as const,
  finalAcceptance: "human" as const,
};
function findDefinition(
  saved: WorkflowDefinition[] = [],
  templates: WorkflowDefinition[] = [],
  id: string,
) {
  return saved.find((entry) => entry.id === id) || templates.find((entry) => entry.id === id);
}
function graphOf(definition: WorkflowDefinition, maxParallel = 4) {
  return { maxParallel, roles: definition.roles, boards: definition.boards };
}
function mutationError(...errors: unknown[]) {
  return errors.find(Boolean);
}
function previewReady(
  request: string,
  definition: WorkflowDefinition | undefined,
  draft: WorkflowDefinition | null,
  cwd: string,
  pending: boolean,
) {
  return Boolean(request.trim() && definition && !draft && cwd && !pending);
}
function variantOf(definition: WorkflowDefinition): WorkflowDefinition {
  if (definition.revision || definition.id !== definition.basePackId) return definition;
  return {
    ...definition,
    id: `${definition.basePackId}-${Date.now().toString(36)}`,
    title: `${definition.title} custom`,
  };
}

export function WorkflowBuilder(props: PluginSurfaceProps & { projectPath?: string }) {
  const styles = useFactoryStyles(props);
  const paseo = usePaseo();
  const cache = useQueryClient();
  const list = useRpc(factoryWorkflowsList);
  const readPacks = useRpc(factoryPacks);
  const save = useRpc(factoryWorkflowSave);
  const design = useRpc(factoryWorkflowPreview);
  const apply = useRpc(factoryWorkflowApply);
  const library = useQuery({ queryKey: ["factory", "workflows"], queryFn: () => list({}) });
  const packs = useQuery({ queryKey: ["factory", "packs"], queryFn: () => readPacks({}) });
  const projects = useQuery({
    queryKey: ["factory", "projects"],
    queryFn: () => paseo.projects.list({}),
  });
  const [selected, setSelected] = useState("kitchen");
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [request, setRequest] = useState("");
  const [cwd, setCwd] = useState(props.projectPath || "");
  const [role, setRole] = useState("");
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [addRole, setAddRole] = useState(false);
  const definitions = library.data?.workflows;
  const templates = library.data?.templates;
  const saved = findDefinition(definitions, templates, selected);
  const definition = draft || saved;
  const workflow = useMemo(
    () =>
      definition
        ? {
            ...packs.data?.packs.find((pack) => pack.id === definition.basePackId)?.workflow,
            maxParallel:
              packs.data?.packs.find((pack) => pack.id === definition.basePackId)?.workflow
                .maxParallel || 4,
            roles: definition.roles,
            boards: definition.boards,
          }
        : undefined,
    [definition, packs.data],
  );
  const choose = useCallback((id: string) => {
    setSelected(id);
    setDraft(null);
    setRole("");
    setPreview(null);
  }, []);
  const closeRole = useCallback(() => setRole(""), []);
  const closePreview = useCallback(() => setPreview(null), []);
  const closeAdd = useCallback(() => setAddRole(false), []);
  const roleOptions = useMemo(
    () =>
      [...(templates || []), ...(definitions || [])].map((entry) => ({
        id: entry.id,
        title: `${entry.title}${entry.revision ? "" : " (default)"}`,
      })),
    [templates, definitions],
  );
  const projectOptions = useMemo(
    () =>
      (projects.data?.projects || []).map((entry) => ({
        id: entry.projectRootPath,
        title: entry.projectDisplayName,
      })),
    [projects.data],
  );
  const savedSuccessfully = useCallback(
    async (result: WorkflowDefinition) => {
      setSelected(result.id);
      setDraft(null);
      setRole("");
      setAddRole(false);
      setPreview(null);
      await cache.invalidateQueries({ queryKey: ["factory", "workflows"] });
    },
    [cache],
  );
  const saving = useMutation({
    mutationFn: (value: WorkflowDefinition) =>
      save({ definition: value, expectedRevision: value.revision }),
    onSuccess: savedSuccessfully,
  });
  const designing = useMutation({
    mutationFn: (input: { request: string; role?: string }) => {
      if (!saved || draft)
        throw new Error("Save or discard your draft before asking Kitchen to change it.");
      const candidate = variantOf(saved);
      return design({
        id: candidate.id,
        basePackId: saved.basePackId,
        cwd: props.projectPath || cwd,
        request: input.request,
        expectedRevision: candidate.revision,
        role: input.role,
      });
    },
    onSuccess: setPreview,
  });
  const applying = useMutation({
    mutationFn: (value: WorkflowPreview) =>
      apply({ previewId: value.previewId, expectedRevision: value.expectedRevision }),
    onSuccess: savedSuccessfully,
  });
  const ask = useCallback(() => designing.mutate({ request }), [designing, request]);
  const persist = useCallback(() => {
    if (draft) saving.mutate(draft);
  }, [draft, saving]);
  const discard = useCallback(() => setDraft(null), []);
  const graphChanged = useCallback(
    (changed: RoleWorkflow) => {
      if (!definition) return;
      const candidate = variantOf(definition);
      setDraft({ ...candidate, boards: changed.boards });
    },
    [definition],
  );
  const updateName = useCallback(
    (title: string) => {
      if (definition) setDraft({ ...variantOf(definition), title });
    },
    [definition],
  );
  const persistRole = useCallback(
    (value: WorkflowDefinition) => saving.mutate(variantOf(value)),
    [saving],
  );
  const askRole = useCallback(
    (text: string, id: string) => designing.mutate({ request: text, role: id }),
    [designing],
  );
  const applyPreview = useCallback(() => {
    if (preview) applying.mutate(preview);
  }, [preview, applying]);
  const openAdd = useCallback(() => setAddRole(true), []);
  const askNewRole = useCallback(
    (text: string) => {
      setAddRole(false);
      designing.mutate({ request: `Add a role for this responsibility: ${text}` });
    },
    [designing],
  );
  const error = mutationError(
    library.error,
    packs.error,
    saving.error,
    designing.error,
    applying.error,
  );
  return (
    <View style={styles.stack}>
      <View style={styles.header}>
        <View style={styles.roleSummary}>
          <Text style={styles.title}>Team & workflow editor</Text>
          <Text style={styles.muted}>
            Describe the team you need. Follow how work passes between its roles.
          </Text>
        </View>
        <View style={styles.row}>
          <Action
            theme={props.theme}
            title="+ Add role"
            value="add"
            onAction={openAdd}
            disabled={!definition || Boolean(draft)}
            variant="secondary"
          />
          <Action
            theme={props.theme}
            title={saving.isPending ? "Saving…" : "Save changes"}
            value="save"
            onAction={persist}
            disabled={!draft || saving.isPending}
            variant="primary"
          />
        </View>
      </View>
      <Choice
        {...props}
        label="Workflow"
        value={selected}
        options={roleOptions}
        onChange={choose}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {String(error)}
        </Text>
      ) : null}
      {library.isPending ? <Text style={styles.muted}>Loading the team…</Text> : null}
      {draft ? (
        <View style={styles.row}>
          <Text style={styles.muted}>Unsaved workflow changes</Text>
          <Action theme={props.theme} title="Discard draft" value="discard" onAction={discard} />
        </View>
      ) : null}
      {workflow ? (
        <RoleGraph {...props} workflow={workflow} onRole={setRole} onChange={graphChanged} />
      ) : null}
      <AskKitchen
        {...props}
        request={request}
        onRequest={setRequest}
        cwd={cwd}
        onCwd={setCwd}
        projectOptions={projectOptions}
        pending={designing.isPending}
        ready={previewReady(
          request,
          definition,
          draft,
          props.projectPath || cwd,
          designing.isPending,
        )}
        onAsk={ask}
      />
      {definition ? (
        <Disclosure
          theme={props.theme}
          title="Workflow rules"
          summary="Delegation, communication and decisions. Verification and final acceptance stay protected."
        >
          <Field
            theme={props.theme}
            label="Workflow name"
            value={definition.title}
            onChange={updateName}
          />
          <AutonomyRules {...props} definition={definition} onChange={setDraft} />
          <Text style={styles.text}>
            Independent verification and your final acceptance are required.
          </Text>
          <Text style={styles.muted}>
            Parallel capacity is shared by this host and is configured in Settings. Mission budgets
            are optional in the start form.
          </Text>
        </Disclosure>
      ) : null}
      {definition?.roles[role] ? (
        <WorkflowRoleEditor
          key={`${definition.id}:${role}`}
          {...props}
          definition={definition}
          role={role}
          cwd={props.projectPath || cwd}
          pending={saving.isPending || designing.isPending}
          error={error}
          onSave={persistRole}
          onDesign={askRole}
          onClose={closeRole}
        />
      ) : null}
      {addRole ? (
        <NewRoleRequest
          {...props}
          pending={designing.isPending}
          onDesign={askNewRole}
          onClose={closeAdd}
        />
      ) : null}
      {preview ? (
        <WorkflowPreviewSheet
          {...props}
          preview={preview}
          pending={applying.isPending}
          error={applying.error}
          onApply={applyPreview}
          onClose={closePreview}
        />
      ) : null}
    </View>
  );
}

function WorkflowRoleEditor(
  props: PluginSurfaceProps & {
    definition: WorkflowDefinition;
    role: string;
    cwd: string;
    pending: boolean;
    error: unknown;
    onSave(value: WorkflowDefinition): void;
    onDesign(text: string, role: string): void;
    onClose(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const { definition, role, onSave, onDesign } = props;
  const initial = definition.roles[role];
  const [name, setName] = useState(initial.title);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [skills, setSkills] = useState(initial.skills);
  const [canEdit, setCanEdit] = useState(initial.canEdit);
  const [communication, setCommunication] = useState(
    initial.communication || {
      clarification: "head-chef" as const,
      investigation: "request-work" as const,
    },
  );
  const [profile, setProfile] = useState<RoleProfileOverride>(
    definition.roleProfiles?.[role] || emptyProfile,
  );
  const [cwd, setCwd] = useState(props.cwd);
  const save = useCallback(
    () =>
      onSave({
        ...definition,
        roles: {
          ...definition.roles,
          [role]: {
            ...initial,
            title: name.trim(),
            instructions,
            skills,
            canEdit,
            communication,
          },
        },
        roleProfiles: { ...definition.roleProfiles, [role]: profile },
      }),
    [
      onSave,
      definition,
      role,
      initial,
      name,
      instructions,
      skills,
      canEdit,
      communication,
      profile,
    ],
  );
  const design = useCallback(() => onDesign(instructions, role), [onDesign, instructions, role]);
  const toggleEdit = useCallback(() => setCanEdit((value) => !value), []);
  const clarification = useCallback(
    (value: string) =>
      setCommunication((current) => ({
        ...current,
        clarification: value === "human" ? "human" : "head-chef",
      })),
    [],
  );
  const investigation = useCallback(
    (value: string) =>
      setCommunication((current) => ({
        ...current,
        investigation: value === "human" ? "human" : "request-work",
      })),
    [],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footerActions}>
        <Action
          theme={props.theme}
          title="Cancel"
          value="cancel"
          onAction={props.onClose}
          variant="secondary"
        />
        <Action
          theme={props.theme}
          title={props.pending ? "Saving…" : "Save role"}
          value="save"
          onAction={save}
          disabled={props.pending || !name.trim() || !instructions.trim()}
          variant="primary"
        />
      </View>
    ),
    [styles.footerActions, props, save, name, instructions],
  );
  return (
    <SurfaceSheet {...props} title={initial.title} onClose={props.onClose} footer={footer} side>
      {props.error ? <Text style={styles.danger}>{String(props.error)}</Text> : null}
      <Field
        theme={props.theme}
        label="What should this agent do?"
        value={instructions}
        onChange={setInstructions}
        multiline
      />
      <Action
        theme={props.theme}
        title={props.pending ? "Designing…" : "Improve with AI"}
        value="design"
        onAction={design}
        disabled={props.pending || !cwd || !instructions.trim()}
        variant="secondary"
      />
      <Text style={styles.muted}>
        AI changes open a structured preview. Use Save role to store these instructions and
        preferences directly.
      </Text>
      <Disclosure
        theme={props.theme}
        title="Agent model"
        summary={[
          profile.provider || "Inherited provider",
          profile.model || "Inherited model",
        ].join(" / ")}
      >
        <RuntimeProfile {...props} cwd={cwd} onCwd={setCwd} value={profile} onChange={setProfile} />
      </Disclosure>
      <SkillChips {...props} value={skills} onChange={setSkills} />
      <Text style={styles.heading}>Communication</Text>
      <Choice
        {...props}
        label="When requirements are unclear"
        value={communication.clarification}
        options={clarificationOptions}
        onChange={clarification}
      />
      <Choice
        {...props}
        label="When more investigation is needed"
        value={communication.investigation}
        options={investigationOptions}
        onChange={investigation}
      />
      <Disclosure
        theme={props.theme}
        title="Advanced"
        summary="Role name, workspace and edit policy"
      >
        <Field theme={props.theme} label="Role name" value={name} onChange={setName} />
        <Text style={styles.text}>Workspace: {initial.workspace}</Text>
        <Action
          theme={props.theme}
          title="May edit implementation files"
          selected={canEdit}
          value="edit"
          onAction={toggleEdit}
          disabled={role === "verifier"}
        />
        <Text style={styles.muted}>
          The plugin checks protected changes and report evidence. Host tool permissions depend on
          the agent harness.
        </Text>
      </Disclosure>
    </SurfaceSheet>
  );
}
const clarificationOptions = [
  { id: "head-chef", title: "Ask Head Chef" },
  { id: "human", title: "Ask me" },
];
const investigationOptions = [
  { id: "request-work", title: "Request another work item" },
  { id: "human", title: "Ask me" },
];

function NewRoleRequest(
  props: PluginSurfaceProps & { pending: boolean; onDesign(text: string): void; onClose(): void },
) {
  const [text, setText] = useState("");
  const { onDesign } = props;
  const design = useCallback(() => onDesign(text), [onDesign, text]);
  return (
    <SurfaceSheet {...props} title="Create agent role" onClose={props.onClose}>
      <Field
        theme={props.theme}
        label="What should this agent be responsible for?"
        value={text}
        onChange={setText}
        multiline
        autoFocus
        placeholder="Check database migrations for backwards compatibility and data-loss risks."
      />
      <Action
        theme={props.theme}
        title={props.pending ? "Designing…" : "Design this role"}
        value="design"
        onAction={design}
        disabled={!text.trim() || props.pending}
        variant="primary"
      />
    </SurfaceSheet>
  );
}
function WorkflowPreviewSheet(
  props: PluginSurfaceProps & {
    preview: WorkflowPreview;
    pending: boolean;
    error: unknown;
    onApply(): void;
    onClose(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const workflow = useMemo(() => graphOf(props.preview.definition), [props.preview.definition]);
  return (
    <SurfaceSheet {...props} title="I understood" onClose={props.onClose}>
      {props.error ? <Text style={styles.danger}>{String(props.error)}</Text> : null}
      {[...new Set(props.preview.summary)].map((text) => (
        <Text key={text} style={styles.text}>
          {text}
        </Text>
      ))}
      <Disclosure
        theme={props.theme}
        title="Preview workflow"
        summary="Inspect the proposed stages and handoffs."
      >
        <RoleGraph {...props} workflow={workflow} onRole={noRoleSelection} />
      </Disclosure>
      <Text style={styles.muted}>
        {props.preview.model} proposed these changes. Existing missions keep their workflow version.
      </Text>
      <View style={styles.footerActions}>
        <Action
          theme={props.theme}
          title="Cancel"
          value="cancel"
          onAction={props.onClose}
          variant="secondary"
        />
        <Action
          theme={props.theme}
          title={props.pending ? "Applying…" : "Apply changes"}
          value="apply"
          onAction={props.onApply}
          disabled={props.pending}
          variant="primary"
        />
      </View>
    </SurfaceSheet>
  );
}

function SkillChips(
  props: PluginSurfaceProps & { value: string[]; onChange(value: string[]): void },
) {
  const styles = useFactoryStyles(props);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const { value, onChange } = props;
  const open = useCallback(() => setAdding(true), []);
  const cancel = useCallback(() => {
    setAdding(false);
    setName("");
  }, []);
  const add = useCallback(() => {
    const skill = name.trim();
    if (skill && !value.includes(skill)) onChange([...value, skill]);
    setAdding(false);
    setName("");
  }, [name, value, onChange]);
  const remove = useCallback(
    (skill: string) => onChange(value.filter((entry) => entry !== skill)),
    [value, onChange],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Skills</Text>
      <View style={styles.row}>
        {value.map((skill) => (
          <Action
            key={skill}
            theme={props.theme}
            title={`${skill} ×`}
            accessibilityLabel={`Remove skill ${skill}`}
            value={skill}
            onAction={remove}
            variant="secondary"
          />
        ))}
        <Action
          theme={props.theme}
          title="+ Add skill"
          value="add"
          onAction={open}
          variant="secondary"
        />
      </View>
      {adding ? (
        <View style={styles.card}>
          <Field
            theme={props.theme}
            label="Installed skill name"
            value={name}
            onChange={setName}
            placeholder="design-taste-frontend"
            autoFocus
          />
          <View style={styles.footerActions}>
            <Action theme={props.theme} title="Cancel" value="cancel" onAction={cancel} />
            <Action
              theme={props.theme}
              title="Add skill"
              value="add"
              onAction={add}
              disabled={!name.trim()}
              variant="primary"
            />
          </View>
        </View>
      ) : null}
      <Text style={styles.muted}>
        These names are sent to the agent harness. The agent reports missing skills instead of
        pretending to use them.
      </Text>
    </View>
  );
}
function AutonomyRules(
  props: PluginSurfaceProps & {
    definition: WorkflowDefinition;
    onChange(value: WorkflowDefinition): void;
  },
) {
  const styles = useFactoryStyles(props);
  const { definition, onChange } = props;
  const autonomy = definition.autonomy || defaultAutonomy;
  const architecture = useCallback(
    (value: string) =>
      onChange({
        ...variantOf(definition),
        autonomy: { ...autonomy, architecture: value === "head-chef" ? "head-chef" : "human" },
      }),
    [definition, autonomy, onChange],
  );
  const depth = useCallback(
    (value: string) => {
      const amount = value.trim() ? Number(value) : undefined;
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) return;
      onChange({
        ...variantOf(definition),
        runtimePolicy: { ...definition.runtimePolicy!, maxDelegationDepth: amount },
      });
    },
    [definition, onChange],
  );
  const items = useCallback(
    (value: string) => {
      const amount = value.trim() ? Number(value) : undefined;
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) return;
      onChange({
        ...variantOf(definition),
        runtimePolicy: { ...definition.runtimePolicy!, maxDelegatedItems: amount },
      });
    },
    [definition, onChange],
  );
  return (
    <View style={styles.stack}>
      <Choice
        {...props}
        label="Architecture decisions"
        value={autonomy.architecture}
        options={clarificationOptions}
        onChange={architecture}
      />
      <Text style={styles.muted}>
        Head Chef can coordinate delegated work and answer role questions. Missing product
        requirements, irreversible actions and final acceptance are escalated to you.
      </Text>
      {definition.runtimePolicy ? (
        <Disclosure
          theme={props.theme}
          title="Delegation limits"
          summary="Optional. Blank fields allow continued scoped work."
        >
          <Field
            theme={props.theme}
            label="Maximum delegation depth"
            value={String(definition.runtimePolicy.maxDelegationDepth ?? "")}
            onChange={depth}
            keyboardType="number-pad"
            placeholder="No limit"
          />
          <Field
            theme={props.theme}
            label="Maximum delegated work items"
            value={String(definition.runtimePolicy.maxDelegatedItems ?? "")}
            onChange={items}
            keyboardType="number-pad"
            placeholder="No limit"
          />
        </Disclosure>
      ) : null}
    </View>
  );
}

function AskKitchen(
  props: PluginSurfaceProps & {
    projectPath?: string;
    request: string;
    onRequest(value: string): void;
    cwd: string;
    onCwd(value: string): void;
    projectOptions: { id: string; title: string }[];
    pending: boolean;
    ready: boolean;
    onAsk(): void;
  },
) {
  const styles = useFactoryStyles(props);
  return (
    <View style={styles.card}>
      <Field
        theme={props.theme}
        label="Ask Kitchen to change this team"
        value={props.request}
        onChange={props.onRequest}
        multiline
        placeholder="Add a Security Reviewer after Review, only when authentication or permission files changed. On a finding, return to Build."
      />
      {!props.projectPath ? (
        <Choice
          {...props}
          label="Project context"
          value={props.cwd}
          options={props.projectOptions}
          onChange={props.onCwd}
        />
      ) : null}
      <View style={styles.footerActions}>
        <Action
          theme={props.theme}
          title={props.pending ? "Designing…" : "Preview changes"}
          value="preview"
          onAction={props.onAsk}
          disabled={!props.ready}
          variant="primary"
        />
      </View>
      <Text style={styles.muted}>
        Kitchen proposes structured changes. Nothing is applied until you confirm.
      </Text>
    </View>
  );
}
