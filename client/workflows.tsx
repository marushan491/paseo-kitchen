import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  factoryPacks,
  factoryProfilesList,
  factoryProfilesSave,
  factoryProfilesRemove,
  factoryWorkConfigure,
  type RoleProfileOverride,
  type WorkflowProfile,
  type TeamState,
} from "../shared/factory-contracts.js";
import { Action, Field, Disclosure, SurfaceSheet, useFactoryStyles } from "./ui.js";
import { Choice } from "./choice.js";
import { RoleBriefFields } from "./role-editor-fields.js";
import { RoleGraph } from "./role-graph.js";
import { roleTemplate, type RoleWorkflow } from "../shared/role-builder.js";
import { resolveWorkflowSteps } from "./workflow-steps.js";

const stageLabels: Record<string, string> = {
  po: "Plan",
  developer: "Build",
  reviewer: "Review",
  verifier: "Verify",
  integrator: "Integrate",
  tester: "Test",
};
const emptyProfile: RoleProfileOverride = {};
const emptyRoles: Record<string, { title: string }> = {};
const roleGuides: Record<string, { purpose: string; instructions: string }> = {
  po: {
    purpose: "Turns the goal into scoped tasks and dependencies.",
    instructions:
      "Read the project instructions. Keep each task tied to the goal and acceptance criteria. Ask when a product decision is missing.",
  },
  developer: {
    purpose: "Builds a feature in an isolated worktree.",
    instructions:
      "Inspect the existing implementation before editing. Make verifiable changes, run affected checks and report evidence. Request missing scoped work when needed.",
  },
  reviewer: {
    purpose: "Reviews changes and can correct the implementation.",
    instructions:
      "Review against the task's requirements. Correct concrete defects and record changes with evidence. Leave independent verification to the Verifier.",
  },
  verifier: {
    purpose: "Independently checks the result and its evidence.",
    instructions:
      "Verify the actual checkout and acceptance criteria. Report failed checks explicitly. Do not claim a pass from another agent's summary.",
  },
  integrator: {
    purpose: "Combines verified features and prepares the final result.",
    instructions:
      "Integrate only verified changes. Resolve conflicts, check the combined result and record the final commit for independent verification.",
  },
  tester: {
    purpose: "Runs the task's checks and reports concrete failures.",
    instructions:
      "Run affected tests against the actual implementation and report reproducible results.",
  },
};

function useProfiles() {
  const list = useRpc(factoryProfilesList);
  return useQuery({ queryKey: ["factory", "profiles"], queryFn: () => list({}) });
}

export function RoleAssignments(
  props: PluginSurfaceProps & {
    roles: Record<string, { id?: string; title: string }>;
    value: Record<string, RoleProfileOverride>;
    onChange(value: Record<string, RoleProfileOverride>): void;
  },
) {
  const profiles = useProfiles();
  const styles = useFactoryStyles(props);
  const options = useMemo(() => profileChoices(profiles.data?.profiles), [profiles.data]);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Your team</Text>
      <Text style={styles.muted}>
        The built-in role instructions work without setup. Project settings are inherited. Expand a
        role to add instructions or installed skills.
      </Text>
      {profiles.error ? <Text style={styles.danger}>{String(profiles.error)}</Text> : null}
      {Object.entries(props.roles).map(([role, details]) => (
        <RoleChoice key={role} {...props} role={role} title={details.title} options={options} />
      ))}
    </View>
  );
}

function profileChoices(profiles: WorkflowProfile[] | undefined) {
  return (profiles ?? []).map((profile) => ({
    id: profile.id,
    title: profile.name,
    targetRole: profile.targetRole,
  }));
}

function RoleChoice(
  props: PluginSurfaceProps & {
    role: string;
    title: string;
    options: { id: string; title: string; targetRole?: string }[];
    value: Record<string, RoleProfileOverride>;
    onChange(value: Record<string, RoleProfileOverride>): void;
  },
) {
  const { role, value, onChange } = props;
  const choose = useCallback(
    (id: string) =>
      onChange({ ...value, [role]: { ...value[role], workflowProfileId: id || undefined } }),
    [role, value, onChange],
  );
  const compatibleOptions = useMemo(
    () => props.options.filter((option) => !option.targetRole || option.targetRole === role),
    [props.options, role],
  );
  const profile = value[role] || emptyProfile;
  const styles = useFactoryStyles(props);
  const instructions = useCallback(
    (text: string) =>
      onChange({ ...value, [role]: { ...profile, instructions: text || undefined } }),
    [value, role, profile, onChange],
  );
  const skills = useCallback(
    (text: string) =>
      onChange({
        ...value,
        [role]: {
          ...profile,
          skills: text
            .split("\n")
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
      }),
    [value, role, profile, onChange],
  );
  return (
    <Disclosure
      theme={props.theme}
      title={props.title}
      summary={roleGuides[role]?.purpose || "Runs this workflow role."}
    >
      <Text style={styles.muted}>
        Built-in instructions + project defaults
        {profile.workflowProfileId ? " + selected role preset" : ""}
      </Text>
      <Choice
        {...props}
        label="Role preset"
        value={profile.workflowProfileId || ""}
        options={compatibleOptions}
        allowEmpty
        emptyTitle="Use built-in role + project defaults"
        onChange={choose}
      />
      <Field
        theme={props.theme}
        label={`${props.title} · extra instructions`}
        value={profile.instructions || ""}
        onChange={instructions}
        multiline
        placeholder="Anything this role should do differently?"
      />
      <Field
        theme={props.theme}
        label={`${props.title} · installed skills, one per line`}
        value={profile.skills?.join("\n") || ""}
        onChange={skills}
        multiline
        placeholder="design-taste-frontend"
      />
      <Text style={styles.muted}>
        Names refer to skills available in the agent harness. Missing skills must be reported by the
        agent.
      </Text>
    </Disclosure>
  );
}

export function WorkflowProfiles(props: PluginSurfaceProps & { projectPath?: string }) {
  const profiles = useProfiles();
  const packsRpc = useRpc(factoryPacks);
  const packs = useQuery({ queryKey: ["factory", "packs"], queryFn: () => packsRpc({}) });
  const workflow = packs.data?.packs.find((pack) => pack.id === "kitchen")?.workflow;
  const roles = workflow?.roles || emptyRoles;
  const styles = useFactoryStyles(props);
  const [editing, setEditing] = useState<WorkflowProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const cache = useQueryClient();
  const save = useRpc(factoryProfilesSave);
  const remove = useRpc(factoryProfilesRemove);
  const mutation = useMutation({
    mutationFn: ({ profile, cwd }: { profile: WorkflowProfile; cwd: string }) =>
      save({ profile, cwd, actorId: "human" }),
    onSuccess: async () => {
      setEditing(null);
      setCreating(false);
      await cache.invalidateQueries({ queryKey: ["factory", "profiles"] });
    },
  });
  const [deleteId, setDeleteId] = useState("");
  const deletion = useMutation({
    mutationFn: (id: string) => remove({ id, actorId: "human" }),
    onSuccess: async () => {
      setDeleteId("");
      await cache.invalidateQueries({ queryKey: ["factory", "profiles"] });
    },
  });
  const create = useCallback(() => {
    if (!workflow) return;
    const role = workflow.roles.developer ? "developer" : Object.keys(workflow.roles)[0];
    if (!role) return;
    setEditing(roleTemplate(workflow, role, `role-${Date.now()}`));
    setCreating(true);
  }, [workflow]);
  const edit = useCallback((profile: WorkflowProfile) => {
    setEditing(profile);
    setCreating(false);
  }, []);
  const cancel = useCallback(() => {
    setEditing(null);
    setCreating(false);
  }, []);
  const persist = useCallback(
    (profile: WorkflowProfile, cwd: string) => mutation.mutate({ profile, cwd }),
    [mutation],
  );
  const deleteProfile = useCallback((id: string) => deletion.mutate(id), [deletion]);
  const customize = useCallback(
    (role: string) => {
      if (!workflow) return;
      setEditing(roleTemplate(workflow, role, `custom-${role}-${Date.now()}`));
      setCreating(false);
    },
    [workflow],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.title}>Team</Text>
      <Text style={styles.text}>
        Your Head Chef coordinates the mission. Each role has a clear responsibility and hands its
        result to the next stage.
      </Text>
      <Text style={styles.muted}>
        The standard team is ready. Edit a role to create a reusable preset with your instructions,
        skills and model preferences.
      </Text>
      <View style={styles.card}>
        <Text style={styles.heading}>Standard team</Text>
        <Text style={styles.muted}>
          Plan → Build → Review → Verify → Integrate → Final verification
        </Text>
        {packs.error ? <Text style={styles.danger}>{String(packs.error)}</Text> : null}
        {Object.entries(roles).map(([role, details]) => (
          <View key={role} style={styles.roleLine}>
            <View style={styles.alignedRow}>
              <View style={styles.roleSummary}>
                <Text style={styles.heading}>{stageLabels[role] || details.title}</Text>
                <Text style={styles.muted}>
                  {roleGuides[role]?.purpose || "Runs this workflow role."}
                </Text>
              </View>
              <Action
                theme={props.theme}
                title="Edit"
                accessibilityLabel={`Edit ${stageLabels[role] || details.title} role`}
                value={role}
                onAction={customize}
                variant="secondary"
              />
            </View>
          </View>
        ))}
      </View>
      {workflow ? (
        <Disclosure
          theme={props.theme}
          title="How the team hands work over"
          summary="See the actual workflow, returns and verification gates."
        >
          <RoleGraph {...props} workflow={workflow} onRole={customize} />
        </Disclosure>
      ) : null}
      <View style={styles.header}>
        <Text style={styles.heading}>Role presets</Text>
        <Action
          theme={props.theme}
          title="+ Role preset"
          variant="primary"
          disabled={!workflow}
          value="new"
          onAction={create}
        />
      </View>
      <Text style={styles.muted}>
        Save a role recipe once and reuse it in a mission. A preset changes that role’s
        instructions; the selected workflow pack defines the handoffs.
      </Text>
      {profiles.isPending ? <Text style={styles.muted}>Loading role presets…</Text> : null}
      <LoadError {...props} label="Role presets" error={profiles.error} />
      <LoadError {...props} label="Save role preset" error={mutation.error} />
      <LoadError {...props} label="Delete role preset" error={deletion.error} />
      {!profiles.isPending && profiles.data?.profiles.length === 0 ? (
        <Text style={styles.muted}>
          No role presets saved yet. The built-in team is ready to use.
        </Text>
      ) : null}
      {profiles.data?.profiles.map((profile) => (
        <View key={profile.id} style={styles.card}>
          <Text style={styles.heading}>{profile.name}</Text>
          {profile.targetRole ? (
            <Text style={styles.muted}>
              Role for {roles[profile.targetRole]?.title || profile.targetRole} step ·{" "}
              {profile.brief?.outcome}
            </Text>
          ) : null}
          <Text style={styles.muted}>
            {profile.profile.provider || "Inherited provider"} /{" "}
            {profile.profile.model || "Inherited model"} / {profile.profile.steps?.length || 0}{" "}
            steps
          </Text>
          <View style={styles.row}>
            <Action
              theme={props.theme}
              title="Edit"
              accessibilityLabel={`Edit role preset ${profile.name}`}
              value={profile}
              onAction={edit}
            />
            <Action
              theme={props.theme}
              title="Delete"
              accessibilityLabel={`Delete role preset ${profile.name}`}
              variant="danger"
              value={profile.id}
              onAction={setDeleteId}
            />
          </View>
          {deleteId === profile.id ? (
            <View style={styles.stack}>
              <Text style={styles.text}>
                Delete this library entry? Existing runs keep their saved settings.
              </Text>
              <Action
                theme={props.theme}
                title="Confirm deletion"
                variant="danger"
                value={profile.id}
                onAction={deleteProfile}
                disabled={deletion.isPending}
              />
              <Action theme={props.theme} title="Keep preset" value="" onAction={setDeleteId} />
            </View>
          ) : null}
        </View>
      ))}
      {creating || editing ? (
        <WorkflowEditor
          key={editing?.id || "new"}
          {...props}
          initial={editing || undefined}
          pending={mutation.isPending}
          onSave={persist}
          onCancel={cancel}
          projectPath={props.projectPath}
          workflow={workflow}
        />
      ) : null}
    </View>
  );
}

function WorkflowEditor(
  props: PluginSurfaceProps & {
    initial?: WorkflowProfile;
    workflow?: RoleWorkflow;
    projectPath?: string;
    pending: boolean;
    onSave(profile: WorkflowProfile, cwd: string): void;
    onCancel(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const initial = editorInitial(props.initial);
  const [name, setName] = useState(initial.name);
  const [targetRole, setTargetRole] = useState(initial.targetRole);
  const [brief, setBrief] = useState(initial.brief);
  const roleOptions = useMemo(
    () =>
      Object.entries(props.workflow?.roles || {}).map(([id, details]) => ({
        id,
        title: details.title,
      })),
    [props.workflow],
  );
  const chooseRole = useCallback(
    (role: string) => {
      setTargetRole(role);
      if (!role) {
        setBrief(undefined);
        return;
      }
      if (props.workflow) {
        const template = roleTemplate(props.workflow, role, "draft");
        setName((current) =>
          current === props.workflow?.roles[targetRole]?.title ? template.name : current,
        );
        setBrief(template.brief);
        setProfile((current) => ({
          ...current,
          instructions: template.profile.instructions,
          skills: template.profile.skills,
        }));
      }
    },
    [props.workflow, targetRole],
  );
  const taskChanged = useCallback(
    (task: string) =>
      setBrief((current) => ({
        task,
        responsibility: current?.responsibility || "",
        outcome: current?.outcome || "",
      })),
    [],
  );
  const responsibilityChanged = useCallback(
    (responsibility: string) =>
      setBrief((current) => ({
        task: current?.task || "",
        responsibility,
        outcome: current?.outcome || "",
      })),
    [],
  );
  const outcomeChanged = useCallback(
    (outcome: string) =>
      setBrief((current) => ({
        task: current?.task || "",
        responsibility: current?.responsibility || "",
        outcome,
      })),
    [],
  );
  const [cwd, setCwd] = useState(props.projectPath || "");
  const [profile, setProfile] = useState<RoleProfileOverride>(initial.profile);
  const initialSteps = initial.profile.steps;
  const initialStepText = initialSteps?.map((step) => step.instructions).join("\n") || "";
  const [steps, setSteps] = useState(initialStepText);
  const [stepsEdited, setStepsEdited] = useState(false);
  const stepsChanged = useCallback(
    (text: string) => {
      setSteps(text);
      setStepsEdited(text !== initialStepText);
    },
    [initialStepText],
  );
  const skillsChanged = useCallback(
    (text: string) =>
      setProfile((current) => ({
        ...current,
        skills: text
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
      })),
    [],
  );
  const skillText = profile.skills?.join("\n") || "";
  const runtimeSummary = profile.provider
    ? `Override: ${profile.provider}`
    : "Inherit mission provider and project defaults";
  const id =
    props.initial?.id ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "");
  const { onSave } = props;
  const instructionsChanged = useCallback(
    (instructions: string) => setProfile((current) => ({ ...current, instructions })),
    [],
  );
  const persist = useCallback(
    () =>
      onSave(
        {
          id,
          name: name.trim(),
          targetRole: targetRole || undefined,
          brief,
          profile: {
            ...profile,
            steps: resolveWorkflowSteps(initialSteps, steps, stepsEdited),
          },
        },
        cwd.trim(),
      ),
    [onSave, id, name, profile, initialSteps, steps, stepsEdited, cwd, targetRole, brief],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footerActions}>
        <Action
          theme={props.theme}
          title="Cancel"
          variant="secondary"
          value="cancel"
          onAction={props.onCancel}
          disabled={props.pending}
        />
        <Action
          theme={props.theme}
          title={props.pending ? "Saving…" : "Save preset"}
          variant="primary"
          value="save"
          disabled={props.pending || !id || !name.trim() || !cwd.trim() || !validBrief(brief)}
          onAction={persist}
        />
      </View>
    ),
    [styles.footerActions, props, persist, id, name, cwd, brief],
  );
  return (
    <SurfaceSheet
      {...props}
      title={initial.name ? `Edit ${initial.name}` : "Role preset"}
      onClose={props.onCancel}
      side
      footer={footer}
    >
      <Choice
        {...props}
        label="Role"
        value={targetRole}
        options={roleOptions}
        allowEmpty={!initial.targetRole}
        emptyTitle="Reusable legacy instructions · assign to a role later"
        onChange={chooseRole}
      />
      <Text style={styles.muted}>
        Choose the responsibility you want to customize. Changing roles loads its built-in
        instructions.
      </Text>
      <Field
        theme={props.theme}
        label="Preset name"
        value={name}
        onChange={setName}
        placeholder="For example: Accessibility reviewer"
      />
      <RoleBriefFields
        {...props}
        brief={brief}
        role={targetRole}
        onTask={taskChanged}
        onResponsibility={responsibilityChanged}
        onOutcome={outcomeChanged}
      />
      <Disclosure
        theme={props.theme}
        title="Instructions & skills"
        summary="Only add detail beyond the role description"
      >
        <Field
          theme={props.theme}
          label="Additional instructions"
          value={profile.instructions || ""}
          onChange={instructionsChanged}
          multiline
        />
        <Field
          theme={props.theme}
          label="Ordered steps · one instruction per line"
          value={steps}
          onChange={stepsChanged}
          multiline
        />
        {initialSteps?.length ? (
          <Text style={styles.muted}>
            Editing this field replaces existing step IDs, titles and multiline instructions with
            one step per nonempty line. Leave it unchanged to preserve the original steps.
          </Text>
        ) : null}
        <Field
          theme={props.theme}
          label="Installed skills · one per line"
          value={skillText}
          onChange={skillsChanged}
          multiline
          placeholder="Names of skills available to this role's harness"
        />
      </Disclosure>
      <Disclosure
        theme={props.theme}
        title="Model & project"
        defaultOpen={!cwd}
        summary={runtimeSummary}
      >
        <RuntimeProfile {...props} cwd={cwd} onCwd={setCwd} value={profile} onChange={setProfile} />
      </Disclosure>
      <Text style={styles.muted}>
        Steps are included in the real agent prompt in this order. Kitchen’s phase gates and
        acceptance evidence still apply.
      </Text>
    </SurfaceSheet>
  );
}

function RuntimeProfile(
  props: PluginSurfaceProps & {
    cwd: string;
    onCwd(value: string): void;
    value: RoleProfileOverride;
    onChange(value: RoleProfileOverride): void;
  },
) {
  const { value, onChange, cwd } = props;
  const paseo = usePaseo();
  const styles = useFactoryStyles(props);
  const projects = useQuery({
    queryKey: ["factory", "projects"],
    queryFn: () => paseo.projects.list({}),
  });
  const providers = useQuery({
    queryKey: ["factory", "providers"],
    queryFn: async () => {
      const result = await paseo.providers.listAvailable();
      if (result.error) throw new Error(result.error);
      return result.providers;
    },
  });
  const models = useQuery({
    queryKey: ["factory", "models", value.provider, cwd],
    enabled: Boolean(value.provider && cwd),
    queryFn: async () => {
      const result = await paseo.providers.listModels(value.provider!, { cwd });
      if (result.error) throw new Error(result.error);
      return result.models?.filter((model) => model.isSelectable !== false) || [];
    },
  });
  const modes = useQuery({
    queryKey: ["factory", "modes", value.provider, cwd],
    enabled: Boolean(value.provider && cwd),
    queryFn: async () => {
      const result = await paseo.providers.listModes(value.provider!, { cwd });
      if (result.error) throw new Error(result.error);
      return result.modes || [];
    },
  });
  const projectOptions = useMemo(
    () =>
      (projects.data?.projects ?? []).map((project) => ({
        id: project.projectRootPath,
        title: project.projectDisplayName,
      })),
    [projects.data],
  );
  const providerOptions = useMemo(
    () =>
      (providers.data ?? []).map((provider) => ({
        id: provider.provider,
        title: provider.provider,
        disabled: !provider.available,
      })),
    [providers.data],
  );
  const modelOptions = useMemo(
    () => (models.data ?? []).map((model) => ({ id: model.id, title: model.label })),
    [models.data],
  );
  const modeOptions = useMemo(
    () => (modes.data ?? []).map((mode) => ({ id: mode.id, title: mode.label })),
    [modes.data],
  );
  const thinkingOptions = useMemo(
    () =>
      (models.data?.find((model) => model.id === value.model)?.thinkingOptions ?? []).map(
        (option) => ({ id: option.id, title: option.label }),
      ),
    [models.data, value.model],
  );
  const chooseProvider = useCallback(
    (provider: string) =>
      onChange({
        ...value,
        provider: provider || undefined,
        model: undefined,
        mode: undefined,
        thinking: undefined,
      }),
    [onChange, value],
  );
  const chooseModel = useCallback(
    (model: string) => onChange({ ...value, model: model || undefined, thinking: undefined }),
    [onChange, value],
  );
  const chooseMode = useCallback(
    (mode: string) => onChange({ ...value, mode: mode || undefined }),
    [onChange, value],
  );
  const chooseThinking = useCallback(
    (thinking: string) => onChange({ ...value, thinking: thinking || undefined }),
    [onChange, value],
  );
  return (
    <View style={styles.stack}>
      <Choice
        {...props}
        label="Validation project"
        value={cwd}
        onChange={props.onCwd}
        options={projectOptions}
      />
      <Field theme={props.theme} label="Project directory" value={cwd} onChange={props.onCwd} />
      <Choice
        {...props}
        label="Provider override"
        value={value.provider || ""}
        allowEmpty
        emptyTitle="Inherit provider"
        options={providerOptions}
        onChange={chooseProvider}
      />
      {value.provider ? (
        <>
          <Choice
            {...props}
            label="Model override"
            value={value.model || ""}
            allowEmpty
            emptyTitle="Inherit model"
            options={modelOptions}
            onChange={chooseModel}
          />
          <Choice
            {...props}
            label="Mode override"
            value={value.mode || ""}
            allowEmpty
            emptyTitle="Inherit mode"
            options={modeOptions}
            onChange={chooseMode}
          />
          <Choice
            {...props}
            label="Thinking override"
            value={value.thinking || ""}
            allowEmpty
            emptyTitle="Inherit thinking"
            options={thinkingOptions}
            onChange={chooseThinking}
          />
        </>
      ) : null}
      <Text style={styles.muted}>
        Using the same provider inherits the source or project model. Changing provider uses its
        default model when no model override is selected.
      </Text>
      <LoadError {...props} label="Projects" error={projects.error} />
      <LoadError {...props} label="Providers" error={providers.error} />
      <LoadError {...props} label="Models" error={models.error} />
      <LoadError {...props} label="Modes" error={modes.error} />
    </View>
  );
}

function LoadError(props: PluginSurfaceProps & { label: string; error: unknown }) {
  const styles = useFactoryStyles(props);
  if (!props.error) return null;
  return (
    <Text style={styles.danger}>
      {props.label}: {String(props.error)}
    </Text>
  );
}

export function WorkItemProfileSettings(
  props: PluginSurfaceProps & {
    state: TeamState;
    workItemId: string;
    roles: Record<string, { id?: string; title: string }>;
    initialRole?: string;
  },
) {
  const styles = useFactoryStyles(props);
  const item = props.state.items[props.workItemId];
  const [role, setRole] = useState(props.initialRole || Object.keys(props.roles)[0] || "");
  const [workflow, setWorkflow] = useState("");
  const [instructions, setInstructions] = useState("");
  const [skills, setSkills] = useState("");
  const profiles = useProfiles();
  const configure = useRpc(factoryWorkConfigure);
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      configure({
        teamId: props.state.team.id,
        workItemId: props.workItemId,
        role,
        profile: {
          workflowProfileId: workflow || undefined,
          instructions: instructions || undefined,
          skills: skills
            .split("\n")
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
        actorId: "human",
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["factory"] }),
  });
  const roleOptions = useMemo(
    () => Object.entries(props.roles).map(([id, details]) => ({ id, title: details.title })),
    [props.roles],
  );
  const profileOptions = useMemo(
    () =>
      profileChoices(profiles.data?.profiles).filter(
        (entry) => !entry.targetRole || entry.targetRole === role,
      ),
    [profiles.data, role],
  );
  const chooseRole = useCallback(
    (value: string) => {
      setRole(value);
      setWorkflow("");
      setInstructions("");
      setSkills("");
      mutation.reset();
    },
    [mutation],
  );
  const apply = useCallback(() => mutation.mutate(), [mutation]);
  if (!item) return <Text style={styles.danger}>Work item is unavailable.</Text>;
  const bindings = Object.values(props.state.bindings).filter(
    (binding) => binding.workItemId === item.id && binding.role === role,
  );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Agent workflow · {item.title}</Text>
      <Choice {...props} label="Role" value={role} options={roleOptions} onChange={chooseRole} />
      {bindings.map((binding) => (
        <View key={binding.id} style={styles.stack}>
          <Text selectable style={styles.text}>
            {binding.status} · {binding.agentId || "Starting"}
          </Text>
          <Text style={styles.muted}>
            Executing:{" "}
            {binding.executedProfile
              ? [
                  binding.executedProfile.provider,
                  binding.executedProfile.model,
                  binding.executedProfile.mode,
                  binding.executedProfile.thinking,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Profile snapshot unavailable for this older binding"}
          </Text>
          {binding.executedProfile?.steps?.map((step) => (
            <Text key={step.id} style={styles.muted}>
              {step.title}
            </Text>
          ))}
        </View>
      ))}
      <Text style={styles.muted}>
        Next role agent:{" "}
        {item.roleProfiles?.[role]?.workflowProfileId || "Source / project / run settings"}
      </Text>
      <Choice
        {...props}
        label="Workflow for next role agent"
        value={workflow}
        allowEmpty
        emptyTitle="Inherit run settings"
        options={profileOptions}
        onChange={setWorkflow}
      />
      <Field
        theme={props.theme}
        label="Extra role instructions"
        value={instructions}
        onChange={setInstructions}
        multiline
      />
      <Field
        theme={props.theme}
        label="Installed role skills · one per line"
        value={skills}
        onChange={setSkills}
        multiline
      />
      <Text style={styles.muted}>
        Applies when Kitchen starts a new agent for this role. The current agent keeps its executing
        profile.
      </Text>
      <Action
        theme={props.theme}
        title={mutation.isPending ? "Applying…" : "Apply to next role agent"}
        variant="secondary"
        value="apply"
        onAction={apply}
        disabled={
          !role || mutation.isPending || ["done", "canceled"].includes(props.state.team.status)
        }
      />
      {mutation.isSuccess ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          Saved for the next role agent.
        </Text>
      ) : null}
      {mutation.error || profiles.error ? (
        <Text style={styles.danger}>{String(mutation.error || profiles.error)}</Text>
      ) : null}
    </View>
  );
}

function editorInitial(profile?: WorkflowProfile) {
  return {
    name: profile?.name || "",
    targetRole: profile?.targetRole || "",
    brief: profile?.brief,
    profile: profile?.profile || emptyProfile,
  };
}

function validBrief(brief?: WorkflowProfile["brief"]) {
  return (
    !brief || Boolean(brief.task.trim() && brief.responsibility.trim() && brief.outcome.trim())
  );
}
