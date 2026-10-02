import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useState } from "react";
import { ScrollView, Text } from "react-native";
import { factorySettings } from "../shared/preferences.js";
import { Action, Field, useFactoryStyles } from "./ui.js";

export function FactorySettings(props: PluginSurfaceProps) {
  const state = useSettings(factorySettings);
  const styles = useFactoryStyles(props);
  if (state.status !== "ready")
    return (
      <Text style={styles.muted}>
        {state.status === "loading" ? "Loading factory settings…" : state.error}
      </Text>
    );
  return <ReadySettings {...props} state={state} key={state.revision} />;
}

function ReadySettings(
  props: PluginSurfaceProps & {
    state: Extract<SettingsState<typeof factorySettings.schema>, { status: "ready" }>;
  },
) {
  const { state, theme } = props;
  const styles = useFactoryStyles(props);
  const [directory, setDirectory] = useState(state.values.dataDirectory);
  const [concurrency, setConcurrency] = useState(
    String(Math.min(4, state.values.maxConcurrentAgents)),
  );
  const [daemonHost, setDaemonHost] = useState(state.values.daemonHost);
  const [daemonHome, setDaemonHome] = useState(state.values.daemonHome);
  const [cliExecutable, setCliExecutable] = useState(state.values.cliExecutable);
  const [cliArguments, setCliArguments] = useState(state.values.cliArguments.join("\n"));
  const [packDirectory, setPackDirectory] = useState(state.values.packDirectory);
  const count = Number(concurrency);
  const exclusiveTarget = !daemonHome.trim() || !daemonHost.trim();
  const valid = Number.isInteger(count) && count >= 1 && count <= 4 && exclusiveTarget;
  const save = useCallback(() => {
    void state.save(
      {
        ...state.values,
        dataDirectory: directory.trim(),
        daemonHost: daemonHost.trim(),
        daemonHome: daemonHome.trim(),
        cliExecutable: cliExecutable.trim(),
        cliArguments: cliArguments.split("\n").filter(Boolean),
        packDirectory: packDirectory.trim(),
        maxConcurrentAgents: count,
      },
      state.revision,
    );
  }, [state, directory, count, daemonHost, daemonHome, cliExecutable, cliArguments, packDirectory]);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Kitchen settings</Text>
      <Text style={styles.muted}>
        After changing the data directory, daemon address or home, CLI executable or arguments, or
        workflow pack directory, reload this plugin in the host’s plugin settings. Saving these
        fields does not reconfigure an already running Kitchen service. The concurrency setting
        applies immediately.
      </Text>
      <Field theme={theme} label="Data directory" value={directory} onChange={setDirectory} />
      <Text style={styles.muted}>
        Leave empty when the host supplies an isolated plugin directory. On hosts without that API,
        choose an absolute directory used only by this plugin. Restart the plugin after changing it.
      </Text>
      <Field
        theme={theme}
        label="Daemon WebSocket address for the public CLI bridge"
        value={daemonHost}
        onChange={setDaemonHost}
      />
      <Field
        theme={theme}
        label="Daemon home for the public CLI bridge"
        value={daemonHome}
        onChange={setDaemonHome}
      />
      <Text style={styles.muted}>
        Set either this host’s explicit WebSocket address or its daemon home. Kitchen uses this
        target for stopping Cooks. Leaving both empty disables CLI actions.
      </Text>
      <Field
        theme={theme}
        label="CLI executable"
        value={cliExecutable}
        onChange={setCliExecutable}
      />
      <Field
        theme={theme}
        label="CLI arguments · one argument per line"
        value={cliArguments}
        onChange={setCliArguments}
        multiline
      />
      <Field
        theme={theme}
        label="Additional workflow pack directory"
        value={packDirectory}
        onChange={setPackDirectory}
      />
      <Field
        theme={theme}
        label="Maximum concurrent Cooks (1–4)"
        value={concurrency}
        onChange={setConcurrency}
      />
      {!valid ? (
        <Text style={styles.danger}>
          Use a whole number from 1 to 4 and only one CLI target: daemon home or WebSocket address.
        </Text>
      ) : null}
      {state.saveError ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {state.saveError}
        </Text>
      ) : null}
      <Action
        theme={theme}
        title={state.saving ? "Saving…" : "Save Kitchen settings"}
        value="save"
        onAction={save}
        disabled={state.saving || !valid || !cliExecutable.trim()}
      />
    </ScrollView>
  );
}
