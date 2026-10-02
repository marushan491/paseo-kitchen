import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { WorkflowProfile } from "../shared/factory-contracts.js";
import { roleReceivers, type RoleWorkflow } from "../shared/role-builder.js";
import { Field, useFactoryStyles } from "./ui.js";

export function RoleBriefFields(
  props: PluginSurfaceProps & {
    brief?: WorkflowProfile["brief"];
    role: string;
    workflow?: RoleWorkflow;
    onTask(value: string): void;
    onResponsibility(value: string): void;
    onOutcome(value: string): void;
  },
) {
  const styles = useFactoryStyles(props);
  const brief = props.brief;
  if (!brief) return null;
  return (
    <View style={styles.stack}>
      <Text style={styles.muted}>
        Role for {props.workflow?.roles[props.role]?.title || props.role} step. Assign this saved
        role to that mission step to use its name, task and instructions. Existing transitions and
        verification gates stay in force.
      </Text>
      <Field
        theme={props.theme}
        label="Task · what should this role do?"
        value={brief.task}
        onChange={props.onTask}
        multiline
      />
      <Field
        theme={props.theme}
        label="Responsibility · what does it own?"
        value={brief.responsibility}
        onChange={props.onResponsibility}
        multiline
      />
      <Field
        theme={props.theme}
        label="Expected outcome · what must it hand back?"
        value={brief.outcome}
        onChange={props.onOutcome}
        multiline
      />
      <Text style={styles.muted}>
        Reports to Head Chef; runtime handoff:{" "}
        {props.workflow ? roleReceivers(props.workflow, props.role).join(" · ") : "pack-defined"}
      </Text>
    </View>
  );
}
