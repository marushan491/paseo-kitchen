import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import type { RoleProfileOverride } from "../shared/factory-contracts.js";
import { Choice } from "./choice.js";
import { Field, useFactoryStyles } from "./ui.js";

export function RuntimeProfile(
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
