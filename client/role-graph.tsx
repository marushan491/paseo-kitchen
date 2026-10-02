import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { type RoleWorkflow, workflowConnections } from "../shared/role-builder.js";
import { Action, useFactoryStyles } from "./ui.js";

export function RoleGraph(
  props: PluginSurfaceProps & {
    workflow: RoleWorkflow;
    onRole(role: string): void;
    selectedRole?: string;
    roleName?: string;
  },
) {
  const styles = useFactoryStyles(props);
  const connections = useMemo(() => workflowConnections(props.workflow), [props.workflow]);
  return (
    <View style={styles.stack}>
      <Text style={styles.heading}>Who hands work to whom</Text>
      <Text style={styles.muted}>
        These are the executable pack transitions. Agents report the shown outcomes to the Head
        Chef; the runtime dispatches the next role. Returns keep review and verification
        independent.
      </Text>
      {Object.entries(props.workflow.boards).map(([boardId, board]) => (
        <View key={boardId} style={styles.card}>
          <Text style={styles.heading}>
            {boardId === "root" ? "Mission · plan and combine results" : `${boardId} · scoped task`}{" "}
            · starts at {board.phases[board.initialPhase]?.title || board.initialPhase}
          </Text>
          <View style={styles.row}>
            {Object.entries(board.phases)
              .filter(
                ([, phase]) =>
                  phase.role || phase.kind === "terminal" || phase.completeWithChildren,
              )
              .map(([phaseId, phase]) => (
                <View key={phaseId} style={styles.roleInfo}>
                  <Text style={styles.heading}>{phase.title}</Text>
                  {phase.role ? (
                    <Action
                      theme={props.theme}
                      title={
                        props.selectedRole === phase.role && props.roleName
                          ? `${props.roleName} · ${props.workflow.roles[phase.role].title}`
                          : props.workflow.roles[phase.role]?.title || phase.role
                      }
                      value={phase.role}
                      onAction={props.onRole}
                      selected={props.selectedRole === phase.role}
                    />
                  ) : (
                    <Text style={styles.muted}>
                      {phase.kind === "terminal"
                        ? "Gate / completed phase"
                        : "Waits for scoped task results"}
                    </Text>
                  )}
                  {connections
                    .filter((edge) => edge.board === boardId && edge.from === phaseId)
                    .map((edge) => (
                      <Text key={edge.id} style={styles.muted}>
                        {edge.label} → {board.phases[edge.to]?.title || edge.to}
                        {board.phases[edge.to]?.role
                          ? ` (${props.workflow.roles[board.phases[edge.to].role!]?.title || board.phases[edge.to].role})`
                          : ""}
                      </Text>
                    ))}
                </View>
              ))}
          </View>
        </View>
      ))}
    </View>
  );
}
