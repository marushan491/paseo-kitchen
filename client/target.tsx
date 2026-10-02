import type { PaseoAgent } from "@getpaseo/client";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { StartKitchenInput } from "../shared/factory-contracts.js";
import { Action, useFactoryStyles } from "./ui.js";

type Target = Pick<
  StartKitchenInput,
  "provider" | "model" | "mode" | "thinking" | "sourceAgentId" | "workspaceId" | "cwd"
>;

export function useKitchenTarget(
  source: PaseoAgent | undefined,
  cwd: string,
  workspaceId?: string,
) {
  const paseo = usePaseo();
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
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
    queryKey: ["factory", "models", provider, cwd],
    enabled: Boolean(provider && cwd),
    queryFn: async () => {
      const result = await paseo.providers.listModels(provider, { cwd });
      if (result.error) throw new Error(result.error);
      return result.models?.filter((entry) => entry.isSelectable !== false) || [];
    },
  });
  const chooseProvider = useCallback((value: string) => {
    setProvider(value);
    setModel("");
  }, []);
  const validModel = models.data?.some((entry) => entry.id === model);
  const target = useMemo<Target>(
    () =>
      source
        ? {
            provider: source.provider,
            model: source.runtimeInfo?.model || undefined,
            mode: source.currentModeId || source.runtimeInfo?.modeId || undefined,
            thinking: source.thinkingOptionId || source.runtimeInfo?.thinkingOptionId || undefined,
            sourceAgentId: source.id,
            workspaceId: source.workspaceId || undefined,
            cwd: cwd.trim() || source.cwd,
          }
        : { provider, model: model || undefined, cwd: cwd.trim(), workspaceId },
    [source, cwd, provider, model, workspaceId],
  );
  return {
    target,
    valid: Boolean(target.cwd && (source || (provider && validModel))),
    projects,
    providers,
    models,
    provider,
    model,
    chooseProvider,
    setModel,
  };
}

export function TargetSelection(
  props: PluginSurfaceProps & {
    selection: ReturnType<typeof useKitchenTarget>;
    hasSource: boolean;
    onProject(path: string): void;
  },
) {
  const { selection, hasSource, theme, onProject } = props;
  const styles = useFactoryStyles(props);
  const error = selection.projects.error || selection.providers.error || selection.models.error;
  return (
    <View style={styles.stack}>
      <Text style={styles.muted}>Project</Text>
      {selection.projects.data?.projects.map((project) => (
        <Action
          key={project.projectId}
          theme={theme}
          title={project.projectDisplayName}
          value={project.projectRootPath}
          onAction={onProject}
        />
      ))}
      {!hasSource ? (
        <>
          <Text style={styles.muted}>Provider · discovered on this host</Text>
          {selection.providers.isPending ? (
            <Text style={styles.muted}>Loading providers…</Text>
          ) : null}
          {selection.providers.data?.map((entry) => (
            <Action
              key={entry.provider}
              theme={theme}
              title={`${entry.provider === selection.provider ? "✓ " : ""}${entry.provider}${entry.available ? "" : " · unavailable"}`}
              value={entry.provider}
              onAction={selection.chooseProvider}
              disabled={!entry.available}
            />
          ))}
          <Text style={styles.muted}>Model · select after choosing a project directory</Text>
          {selection.models.isFetching ? <Text style={styles.muted}>Loading models…</Text> : null}
          {selection.models.data?.map((entry) => (
            <Action
              key={entry.id}
              theme={theme}
              title={`${entry.id === selection.model ? "✓ " : ""}${entry.label}${entry.isDefault ? " · default" : ""}`}
              value={entry.id}
              onAction={selection.setModel}
            />
          ))}
        </>
      ) : (
        <Text style={styles.muted}>
          Provider, model, mode and thinking follow the selected source session.
        </Text>
      )}
      {error ? <Text style={styles.danger}>{String(error)}</Text> : null}
    </View>
  );
}
