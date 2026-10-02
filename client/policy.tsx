import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Text, View } from "react-native";
import type { FactoryPolicy } from "../shared/factory-contracts.js";
import { Action, Field, useFactoryStyles } from "./ui.js";

const policyFields = [
  ["maxTokens", "Maximum observed tokens"],
  ["maxCostUsd", "Maximum observed cost · USD"],
  ["maxAgentStarts", "Maximum worker starts"],
  ["maxChainSteps", "Maximum plugin-dispatched chain steps"],
  ["maxDelegationDepth", "Maximum delegation depth"],
  ["roleActiveMs", "Active time per role · milliseconds"],
  ["totalActiveMs", "Total active time · milliseconds"],
] as const;
import { parsePolicyDraft, type PolicyDraft } from "./kitchen-model.js";
export { parsePolicyDraft, type PolicyDraft } from "./kitchen-model.js";
export function PolicyFields(
  props: PluginSurfaceProps & { value: PolicyDraft; onChange(value: PolicyDraft): void },
) {
  const styles = useFactoryStyles(props);
  const parsed = parsePolicyDraft(props.value);
  const { value, onChange } = props;
  const toggleJudge = useCallback(
    () =>
      onChange({
        ...value,
        requireOutcomeJudge: value.requireOutcomeJudge === "required" ? "" : "required",
      }),
    [value, onChange],
  );
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Mission limits · optional</Text>
      <Text style={styles.muted}>
        Limits apply to this new mission. A selected token or cost limit blocks further paid starts
        when the host cannot measure that value. Blank fields keep the configured runtime defaults.
      </Text>
      <Action
        theme={props.theme}
        title="Require trusted outcome judge"
        selected={value.requireOutcomeJudge === "required"}
        value="judge"
        onAction={toggleJudge}
      />
      {policyFields.map(([name, label]) => (
        <PolicyField key={name} {...props} name={name} label={label} />
      ))}
      {!parsed.success ? (
        <Text style={styles.danger}>
          Limits must be valid numbers; delegation depth may be zero, other limits must be positive.
        </Text>
      ) : null}
    </View>
  );
}
function PolicyField(
  props: PluginSurfaceProps & {
    value: PolicyDraft;
    onChange(value: PolicyDraft): void;
    name: keyof FactoryPolicy;
    label: string;
  },
) {
  const { onChange, value, name } = props;
  const change = useCallback(
    (text: string) => onChange({ ...value, [name]: text }),
    [onChange, value, name],
  );
  return (
    <Field theme={props.theme} label={props.label} value={value[name] || ""} onChange={change} />
  );
}
