import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { PublicationSchema } from "../shared/factory-contracts.js";
import { Action, Field, useFactoryStyles } from "./ui.js";

export interface PublicationDraft {
  enabled: boolean;
  remote: string;
  branch: string;
  baseBranch: string;
}
export const initialPublication: PublicationDraft = {
  enabled: false,
  remote: "origin",
  branch: "",
  baseBranch: "main",
};
export function parsePublication(draft: PublicationDraft) {
  return draft.enabled
    ? PublicationSchema.safeParse(draft)
    : PublicationSchema.optional().safeParse(undefined);
}
export function PublicationFields(
  props: PluginSurfaceProps & { value: PublicationDraft; onChange(value: PublicationDraft): void },
) {
  const styles = useFactoryStyles(props);
  const { value, onChange } = props;
  const toggle = useCallback(
    () => onChange({ ...value, enabled: !value.enabled }),
    [value, onChange],
  );
  const remote = useCallback(
    (text: string) => onChange({ ...value, remote: text }),
    [value, onChange],
  );
  const branch = useCallback(
    (text: string) => onChange({ ...value, branch: text }),
    [value, onChange],
  );
  const base = useCallback(
    (text: string) => onChange({ ...value, baseBranch: text }),
    [value, onChange],
  );
  return (
    <View style={styles.stack}>
      <Action
        theme={props.theme}
        title="Enable explicit pull-request publication"
        selected={value.enabled}
        value="toggle"
        onAction={toggle}
      />
      <Text style={styles.muted}>
        Publication remains a separate credential-approved action after final acceptance; creating
        this mission does not push changes.
      </Text>
      {value.enabled ? (
        <>
          <Field theme={props.theme} label="Git remote" value={value.remote} onChange={remote} />
          <Field
            theme={props.theme}
            label="Publication branch"
            value={value.branch}
            onChange={branch}
          />
          <Field
            theme={props.theme}
            label="Pull-request base branch"
            value={value.baseBranch}
            onChange={base}
          />
        </>
      ) : null}
    </View>
  );
}
