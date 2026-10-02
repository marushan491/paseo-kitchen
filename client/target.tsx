import type { PaseoAgent } from "@getpaseo/client";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Choice } from "./choice.js";
import type { StartKitchenInput } from "../shared/factory-contracts.js";
import { Disclosure, useFactoryStyles } from "./ui.js";

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
  useEffect(() => {
    if (source || provider || !providers.data?.length) return;
    const available = providers.data.filter((entry) => entry.available);
    const preferred = available.find((entry) => entry.provider === "codex") || available[0];
    if (preferred) chooseProvider(preferred.provider);
  }, [source, provider, providers.data, chooseProvider]);
  useEffect(() => {
    if (!models.data?.length || models.data.some((entry) => entry.id === model)) return;
    setModel((models.data.find((entry) => entry.isDefault) || models.data[0])!.id);
  }, [models.data, model]);
  const validModel = models.data?.some((entry) => entry.id === model);
  const target = useMemo<Target>(
    () =>
      source
        ? {
            provider: source.provider,
            model: source.model || source.runtimeInfo?.model || undefined,
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
  const { selection, hasSource, onProject } = props;
  const styles = useFactoryStyles(props);
  const error = selection.projects.error || selection.providers.error || selection.models.error;
  const projectOptions = useMemo(
    () =>
      (selection.projects.data?.projects ?? []).map((project) => ({
        id: project.projectRootPath,
        title: project.projectDisplayName,
      })),
    [selection.projects.data],
  );
  const providerOptions = useMemo(
    () =>
      (selection.providers.data ?? []).map((entry) => ({
        id: entry.provider,
        title: `${entry.provider}${entry.available ? "" : " · unavailable"}`,
        disabled: !entry.available,
      })),
    [selection.providers.data],
  );
  const modelOptions = useMemo(
    () =>
      (selection.models.data ?? []).map((entry) => ({
        id: entry.id,
        title: `${entry.label}${entry.isDefault ? " · default" : ""}`,
      })),
    [selection.models.data],
  );
  return (
    <View style={styles.stack}>
      <Choice
        {...props}
        label="Project"
        value={selection.target.cwd}
        options={projectOptions}
        onChange={onProject}
      />
      {!hasSource ? (
        <Disclosure
          theme={props.theme}
          title="Agent model"
          summary={
            [selection.provider, selection.model].filter(Boolean).join(" · ") ||
            "Loading available defaults…"
          }
        >
          <Choice
            {...props}
            label="Provider"
            value={selection.provider}
            options={providerOptions}
            onChange={selection.chooseProvider}
          />
          {selection.providers.isPending ? (
            <Text style={styles.muted}>Loading providers…</Text>
          ) : null}
          <Choice
            {...props}
            label="Model"
            value={selection.model}
            options={modelOptions}
            onChange={selection.setModel}
          />
          {selection.models.isFetching ? <Text style={styles.muted}>Loading models…</Text> : null}
          {!selection.target.cwd ? (
            <Text style={styles.muted}>Choose a project directory to load models.</Text>
          ) : null}
        </Disclosure>
      ) : (
        <Text style={styles.muted}>
          Provider, model, mode and thinking follow the selected source session.
        </Text>
      )}
      {error ? <Text style={styles.danger}>{String(error)}</Text> : null}
    </View>
  );
}
