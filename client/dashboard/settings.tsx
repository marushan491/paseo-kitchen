import { z } from "zod";
import { normalizeDaemonHost } from "../../shared/dashboard/daemon-host.js";
import { useCallback, useState } from "react";
import { ScrollView, Text } from "react-native";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  dashboardPreference,
  dashboardSettings,
  preferencesSchema,
  scheduleHostSchema,
} from "../../shared/dashboard/contracts.js";
import { normalizeJiraSite } from "../../shared/dashboard/jira.js";
import { Disclosure } from "../ui.js";
import { Action, Field, useDashboardStyles } from "./ui.js";

export function DashboardSettings(props: PluginSurfaceProps) {
  const state = useSettings(dashboardSettings);
  const styles = useDashboardStyles(props);
  if (state.status !== "ready")
    return (
      <Text style={styles.muted}>
        {state.status === "loading" ? "Loading Overview settings…" : state.error}
      </Text>
    );
  return <ReadySettings {...props} state={state} key={state.revision} />;
}

function ReadySettings(
  props: PluginSurfaceProps & {
    state: Extract<SettingsState<typeof dashboardSettings.schema>, { status: "ready" }>;
  },
) {
  const { state, theme } = props;
  const styles = useDashboardStyles(props);
  const importPreferences = useRpc(dashboardPreference);
  const [directory, setDirectory] = useState(state.values.dataDirectory);
  const [home, setHome] = useState(state.values.daemonHome);
  const [executable, setExecutable] = useState(state.values.cliExecutable);
  const [argumentsText, setArguments] = useState(state.values.cliArguments.join("\n"));
  const [hostsText, setHosts] = useState(JSON.stringify(state.values.scheduleHosts, null, 2));
  const [jira, setJira] = useState(state.values.jiraSite);
  const [importText, setImport] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = useCallback(() => {
    setPending(true);
    setError(null);
    setResult(null);
    void Promise.resolve()
      .then(async () => {
        const scheduleHosts = z
          .array(scheduleHostSchema)
          .parse(JSON.parse(hostsText))
          .map((host) => ({
            serverId: host.serverId,
            daemonHost: normalizeDaemonHost(host.daemonHost),
          }));
        await state.save(
          {
            ...state.values,
            dataDirectory: directory.trim(),
            daemonHome: home.trim(),
            cliExecutable: executable.trim(),
            cliArguments: argumentsText.split("\n").filter(Boolean),
            jiraSite: normalizeJiraSite(jira) || "",
            scheduleHosts,
          },
          state.revision,
        );
        return true;
      })
      .then(() => setResult("Settings saved"))
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Could not save settings"),
      )
      .finally(() => setPending(false));
  }, [state, directory, home, executable, argumentsText, jira, hostsText]);
  const loadImport = useCallback(() => {
    setPending(true);
    setError(null);
    setResult(null);
    void Promise.resolve()
      .then(async () => {
        const input: unknown = JSON.parse(importText);
        const legacy = input as { state?: { snoozedUntil?: unknown }; snoozedUntil?: unknown };
        const parsed = preferencesSchema.parse({
          snoozedUntil: legacy.state?.snoozedUntil ?? legacy.snoozedUntil ?? {},
          doneAt: (input as { doneAt?: unknown }).doneAt ?? {},
        });
        await importPreferences({ action: "import", preferences: parsed });
        setImport("");
        setResult("Preferences imported into this plugin");
        return true;
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Import failed"),
      )
      .finally(() => setPending(false));
  }, [importText, importPreferences]);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Dashboard settings</Text>
      <Text style={styles.muted}>
        Inbox and connected-host monitoring. Most installations can keep the current values.
      </Text>
      <Disclosure
        theme={theme}
        title="Local host & preference storage"
        summary="Connection for schedule monitoring and persistent snoozes"
      >
        <Field
          theme={theme}
          label="Separate plugin data directory (absolute path)"
          value={directory}
          onChange={setDirectory}
        />
        <Text style={styles.muted}>
          New hosts supply a private plugin directory. Older hosts need this path or an explicit
          daemon home. Changing the directory switches which Dashboard preferences are loaded.
        </Text>
        <Field
          theme={theme}
          label="This host's daemon home (absolute path)"
          value={home}
          onChange={setHome}
        />
        <Text style={styles.muted}>
          Schedule listing, run outcomes and controls use the public CLI with this explicit home.
          Leave empty to keep schedule monitoring unavailable.
        </Text>
        <Field
          theme={theme}
          label="Public CLI executable"
          value={executable}
          onChange={setExecutable}
        />
        <Field
          theme={theme}
          label="CLI prefix arguments (one per line)"
          value={argumentsText}
          onChange={setArguments}
          multiline
        />
      </Disclosure>
      <Disclosure
        theme={theme}
        title="Additional hosts"
        summary="Optional explicit connections to other schedule hosts"
      >
        <Field
          theme={theme}
          label="Additional schedule hosts JSON [{serverId, daemonHost}]"
          value={hostsText}
          onChange={setHosts}
          multiline
        />
        <Text style={styles.muted}>
          Use exact app server IDs and explicit tcp:// or ws:// endpoints. Unknown hosts are never
          guessed; endpoint credentials are not stored here.
        </Text>
      </Disclosure>
      <Disclosure theme={theme} title="Issue links" summary="Optional Jira site for ticket links">
        <Field theme={theme} label="Jira site" value={jira} onChange={setJira} />
      </Disclosure>
      <Action
        theme={theme}
        title="Save Overview settings"
        variant="primary"
        value={null}
        onAction={save}
        disabled={pending || !executable.trim() || Boolean(jira.trim() && !normalizeJiraSite(jira))}
      />
      <Disclosure
        theme={theme}
        title="Import existing snoozes"
        summary="Optional migration of exported dashboard preferences"
      >
        <Text style={styles.muted}>
          Paste an exported leitstand-preferences JSON object. This imports snoozes into this host’s
          plugin store without changing the old device store. Existing workspace Done metadata is
          read automatically from public snapshots.
        </Text>
        <Field
          theme={theme}
          label="Preference JSON"
          value={importText}
          onChange={setImport}
          multiline
        />
        <Action
          theme={theme}
          title="Import preferences"
          value={null}
          onAction={loadImport}
          disabled={pending || !importText.trim()}
        />
      </Disclosure>
      <Text style={styles.muted}>
        Done/Reopen changes Dashboard status only. Native workspace Done marks, agents and scheduled
        jobs remain separate.
      </Text>
      {result ? <Text style={styles.text}>{result}</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </ScrollView>
  );
}
