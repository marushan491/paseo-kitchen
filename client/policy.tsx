import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Text } from "react-native";
import type { FactoryPolicy } from "../shared/factory-contracts.js";
import { Action, Field, Disclosure, useFactoryStyles } from "./ui.js";

const policyFields = [
  ["maxTokens", "Maximum observed tokens"],
  ["maxCostUsd", "Maximum observed cost · USD"],
  ["maxAgentStarts", "Maximum worker starts"],
  ["maxChainSteps", "Maximum plugin-dispatched chain steps"],
  ["maxDelegationDepth", "Maximum delegation depth"],
  ["maxDelegatedItems", "Maximum additional work items"],
  ["roleActiveMs", "Active time per role · minutes"],
  ["totalActiveMs", "Total active time · minutes"],
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
    <Disclosure
      theme={props.theme}
      title="Budgets & limits"
      summary={
        Object.values(value).some((entry) => entry?.trim())
          ? "Custom limits selected"
          : "No mission budget selected. Kitchen continues until the goal is verified."
      }
    >
      <Text style={styles.muted}>
        Leave fields empty for no limit. Optional token and money budgets require measured usage
        from the host. Parallel capacity is configured separately for this host.
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
          Limits must be valid numbers. Delegation depth and additional items may be zero; other
          limits must be positive.
        </Text>
      ) : null}
    </Disclosure>
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
  const minutes = name === "roleActiveMs" || name === "totalActiveMs";
  let displayed = value[name] || "";
  if (minutes && displayed) displayed = String(Number(displayed) / 60_000);
  const change = useCallback(
    (text: string) =>
      onChange({ ...value, [name]: minutes && text.trim() ? String(Number(text) * 60_000) : text }),
    [onChange, value, name, minutes],
  );
  return (
    <Field
      theme={props.theme}
      label={props.label}
      value={displayed || ""}
      onChange={change}
      placeholder="No limit"
    />
  );
}
