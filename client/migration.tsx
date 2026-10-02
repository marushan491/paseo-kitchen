import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { factoryMigrationInspect, factoryMigrationImport } from "../shared/migration-contracts.js";
import { Action, Field, useFactoryStyles } from "./ui.js";

export function MigrationSettings(props: PluginSurfaceProps) {
  const styles = useFactoryStyles(props);
  const inspect = useRpc(factoryMigrationInspect);
  const importSources = useRpc(factoryMigrationImport);
  const cache = useQueryClient();
  const [draft, setDraft] = useState("");
  const [cwd, setCwd] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const sources = useQuery({
    queryKey: ["factory", "migration", cwd],
    queryFn: () => inspect({ cwd: cwd || undefined }),
  });
  const scan = useCallback(() => {
    setSelected([]);
    setCwd(draft.trim());
    if (draft.trim() === cwd) void sources.refetch();
  }, [draft, cwd, sources]);
  const select = useCallback(
    (id: string) =>
      setSelected((values) =>
        values.includes(id) ? values.filter((value) => value !== id) : [...values, id],
      ),
    [],
  );
  const migration = useMutation({
    mutationFn: () =>
      importSources({
        cwd: cwd || undefined,
        sourceIds: selected,
        confirmBackup: true,
        actorId: "human",
      }),
    onSuccess: async () => {
      setSelected([]);
      await cache.invalidateQueries({ queryKey: ["factory"] });
    },
  });
  const confirm = useCallback(() => migration.mutate(), [migration]);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Import existing Teams, profiles and packs</Text>
      <Text style={styles.muted}>
        Detection is read-only. Import creates a backup first and skips active jobs; it does not
        take over their running agents.
      </Text>
      <Field
        theme={props.theme}
        label="Optional project directory to inspect"
        value={draft}
        onChange={setDraft}
      />
      <Action
        theme={props.theme}
        title="Inspect migration sources"
        value="scan"
        onAction={scan}
        disabled={sources.isFetching || migration.isPending}
      />
      {sources.isPending ? <Text style={styles.muted}>Inspecting configured host…</Text> : null}
      {sources.error || migration.error ? (
        <Text style={styles.danger}>{String(sources.error || migration.error)}</Text>
      ) : null}
      {sources.data?.warnings.map((warning) => (
        <Text key={warning} style={styles.muted}>
          {warning}
        </Text>
      ))}
      {sources.data?.sources.length === 0 ? (
        <Text style={styles.muted}>No importable legacy sources detected.</Text>
      ) : null}
      {sources.data?.sources.map((source) => (
        <View key={source.id} style={styles.card}>
          <Text selectable style={styles.text}>
            {source.kind} · {source.count} entries · {source.path}
          </Text>
          {source.warnings.map((warning) => (
            <Text key={warning} style={styles.muted}>
              {warning}
            </Text>
          ))}
          {source.activeJobs > 0 ? (
            <Text style={styles.muted}>
              {source.activeJobs} active jobs remain with their current runtime.
            </Text>
          ) : null}
          <Action
            theme={props.theme}
            title={`Select ${source.kind}: ${source.path}`}
            selected={selected.includes(source.id)}
            value={source.id}
            onAction={select}
            disabled={source.activeJobs > 0 || migration.isPending}
          />
        </View>
      ))}
      <Action
        theme={props.theme}
        title="Create backup and import selected sources"
        variant="primary"
        value="import"
        onAction={confirm}
        disabled={selected.length === 0 || !sources.data?.backupAvailable || migration.isPending}
      />
      {migration.data ? (
        <View style={styles.card}>
          <Text selectable style={styles.text}>
            Backup: {migration.data.backupRef}
          </Text>
          <Text style={styles.text}>
            Imported: {migration.data.imported.length} · Skipped: {migration.data.skipped.length}
          </Text>
          {migration.data.errors.map((error) => (
            <Text key={error} style={styles.danger}>
              {error}
            </Text>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
