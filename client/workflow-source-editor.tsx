import { type PluginSurfaceProps, openExternalUrl } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { WorkflowDefinition } from "../shared/workflow-contracts.js";
import { parseWorkflowSource } from "./workflow-source.js";
import { Action, useFactoryStyles } from "./ui.js";

const guide = "https://github.com/marushan491/paseo-kitchen/blob/main/docs/workflows.md";
export function WorkflowSourceEditor(
  props: PluginSurfaceProps & {
    definition: WorkflowDefinition;
    onApply(value: WorkflowDefinition): Promise<void>;
  },
) {
  const styles = useFactoryStyles(props);
  const [source, setSource] = useState(() => JSON.stringify(props.definition, null, 2));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setSource(JSON.stringify(props.definition, null, 2));
  }, [props.definition, edited]);
  const edit = useCallback((text: string) => {
    setSource(text);
    setEdited(true);
    setMessage("");
    setError("");
  }, []);
  const reset = useCallback(() => {
    setSource(JSON.stringify(props.definition, null, 2));
    setEdited(false);
    setMessage("");
    setError("");
  }, [props.definition]);
  const copy = useCallback(async () => {
    try {
      await copyText(source);
      setMessage("Workflow JSON copied.");
      setError("");
    } catch {
      setError("Copy was unavailable. Select and copy the JSON from the editor.");
    }
  }, [source]);
  const apply = useCallback(async () => {
    setPending(true);
    setMessage("");
    setError("");
    try {
      await props.onApply(parseWorkflowSource(source));
      setEdited(false);
      setMessage("Validated and applied to the draft. Save changes to keep it.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }, [source, props]);
  const docs = useCallback(() => {
    void openExternalUrl(guide).catch(() => setError("The guide could not be opened."));
  }, []);
  const editorStyle = useMemo(
    () => ({
      height: props.layout.compact ? 260 : 360,
      padding: 14,
      borderWidth: 1,
      borderRadius: 8,
      borderColor: props.theme.colors.border,
      backgroundColor: props.theme.colors.surface0,
      color: props.theme.colors.foreground,
      fontSize: 13,
      lineHeight: 20,
      textAlignVertical: "top" as const,
    }),
    [props.layout.compact, props.theme],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.muted}>
        Edit or paste a workflow. Validation checks real routes, roles and protected verification
        gates before changing the draft.
      </Text>
      <View style={styles.row}>
        <Action
          theme={props.theme}
          title="Copy JSON"
          value="copy"
          onAction={copy}
          variant="secondary"
        />
        <Action
          theme={props.theme}
          title="Reload from graph"
          value="reset"
          onAction={reset}
          disabled={pending}
          variant="secondary"
        />
        <Action theme={props.theme} title="Workflow format guide ↗" value="docs" onAction={docs} />
      </View>
      <Text style={styles.muted}>Workflow JSON{edited ? " / edited" : ""}</Text>
      <TextInput
        accessibilityLabel="Workflow JSON"
        value={source}
        onChangeText={edit}
        multiline
        editable={!pending}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        scrollEnabled
        style={editorStyle}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.danger}>
          {error}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {message}
        </Text>
      ) : null}
      <View style={styles.footerActions}>
        <Action
          theme={props.theme}
          title={pending ? "Validating…" : "Validate and apply to draft"}
          value="apply"
          onAction={apply}
          disabled={pending || !edited}
          variant="primary"
        />
      </View>
    </View>
  );
}
