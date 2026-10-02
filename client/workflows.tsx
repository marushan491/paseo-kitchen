import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  factoryProfilesList,
  factoryProfilesSave,
  factoryProfilesRemove,
  factoryWorkConfigure,
  type RoleProfileOverride,
  type WorkflowProfile,
  type TeamState,
} from "../shared/factory-contracts.js";
import { Action, Field, useFactoryStyles } from "./ui.js";
import { Choice } from "./choice.js";
import { resolveWorkflowSteps } from "./workflow-steps.js";

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
      <Text style={styles.heading}>Role workflows</Text>
      <Text style={styles.muted}>
        Inherit the source and project settings, or choose a saved workflow for each role. Each run
        keeps its resolved settings.
      </Text>
      {profiles.error ? <Text style={styles.danger}>{String(profiles.error)}</Text> : null}
      {Object.entries(props.roles).map(([role, details]) => (
        <RoleChoice key={role} {...props} role={role} title={details.title} options={options} />
      ))}
    </View>
  );
}

function profileChoices(profiles: WorkflowProfile[] | undefined) {
  return (profiles ?? []).map((profile) => ({ id: profile.id, title: profile.name }));
}

function RoleChoice(
  props: PluginSurfaceProps & {
    role: string;
    title: string;
    options: { id: string; title: string }[];
    value: Record<string, RoleProfileOverride>;
    onChange(value: Record<string, RoleProfileOverride>): void;
  },
) {
  const { role, value, onChange } = props;
  const choose = useCallback(
    (id: string) => onChange({ ...value, [role]: id ? { workflowProfileId: id } : {} }),
    [role, value, onChange],
  );
  return (
    <Choice
      {...props}
      label={props.title}
      value={value[role]?.workflowProfileId || ""}
      options={props.options}
      allowEmpty
      emptyTitle="Inherit source / project"
      onChange={choose}
    />
  );
}

export function WorkflowProfiles(props: PluginSurfaceProps) {
  const profiles = useProfiles();
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
    setEditing(null);
    setCreating(true);
  }, []);
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
  return (
    <View style={styles.stack}>
      <View style={styles.row}>
        <Text style={styles.title}>Workflow library</Text>
        <Action
          theme={props.theme}
          title="New workflow"
          variant="primary"
          value="new"
          onAction={create}
        />
      </View>
      <Text style={styles.muted}>
        Reusable instructions and ordered steps, with optional provider, model, mode and thinking
        settings. Apply them to roles when starting a mission or to the next agent on a work item.
      </Text>
      {profiles.isPending ? <Text style={styles.muted}>Loading workflows…</Text> : null}
      <LoadError {...props} label="Workflow library" error={profiles.error} />
      <LoadError {...props} label="Save workflow" error={mutation.error} />
      <LoadError {...props} label="Delete workflow" error={deletion.error} />
      {!profiles.isPending && profiles.data?.profiles.length === 0 ? (
        <Text style={styles.muted}>
          No saved workflows yet. Runs can already inherit the source and project configuration.
        </Text>
      ) : null}
      {profiles.data?.profiles.map((profile) => (
        <View key={profile.id} style={styles.card}>
          <Text style={styles.heading}>{profile.name}</Text>
          <Text style={styles.muted}>
            {profile.profile.provider || "Inherited provider"} ·{" "}
            {profile.profile.model || "Inherited model"} · {profile.profile.steps?.length || 0}{" "}
            steps
          </Text>
          <View style={styles.row}>
            <Action theme={props.theme} title="Edit workflow" value={profile} onAction={edit} />
            <Action
              theme={props.theme}
              title="Delete workflow"
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
              <Action theme={props.theme} title="Keep workflow" value="" onAction={setDeleteId} />
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
        />
      ) : null}
    </View>
  );
}

function WorkflowEditor(
  props: PluginSurfaceProps & {
    initial?: WorkflowProfile;
    pending: boolean;
    onSave(profile: WorkflowProfile, cwd: string): void;
    onCancel(): void;
  },
) {
  const styles = useFactoryStyles(props);
  const [name, setName] = useState(props.initial?.name || "");
  const [cwd, setCwd] = useState("");
  const [profile, setProfile] = useState<RoleProfileOverride>(props.initial?.profile || {});
  const initialSteps = props.initial?.profile.steps;
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
          profile: {
            ...profile,
            steps: resolveWorkflowSteps(initialSteps, steps, stepsEdited),
          },
        },
        cwd.trim(),
      ),
    [onSave, id, name, profile, initialSteps, steps, stepsEdited, cwd],
  );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{props.initial ? "Edit workflow" : "Create workflow"}</Text>
      <Field theme={props.theme} label="Workflow name" value={name} onChange={setName} />
      <RuntimeProfile {...props} cwd={cwd} onCwd={setCwd} value={profile} onChange={setProfile} />
      <Field
        theme={props.theme}
        label="Role instructions"
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
          Editing this field replaces existing step IDs, titles and multiline instructions with one
          step per nonempty line. Leave it unchanged to preserve the original steps.
        </Text>
      ) : null}
      <Text style={styles.muted}>
        Steps are included in the real agent prompt in this order. Kitchen’s phase gates and
        acceptance evidence still apply.
      </Text>
      <View style={styles.row}>
        <Action
          theme={props.theme}
          title={props.pending ? "Saving…" : "Save workflow"}
          variant="primary"
          value="save"
          disabled={props.pending || !id || !name.trim() || !cwd.trim()}
          onAction={persist}
        />
        <Action
          theme={props.theme}
          title="Cancel editing"
          value="cancel"
          onAction={props.onCancel}
        />
      </View>
    </View>
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
  const profiles = useProfiles();
  const configure = useRpc(factoryWorkConfigure);
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      configure({
        teamId: props.state.team.id,
        workItemId: props.workItemId,
        role,
        profile: workflow ? { workflowProfileId: workflow } : {},
        actorId: "human",
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["factory"] }),
  });
  const roleOptions = useMemo(
    () => Object.entries(props.roles).map(([id, details]) => ({ id, title: details.title })),
    [props.roles],
  );
  const profileOptions = useMemo(() => profileChoices(profiles.data?.profiles), [profiles.data]);
  const chooseRole = useCallback(
    (value: string) => {
      setRole(value);
      setWorkflow("");
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
