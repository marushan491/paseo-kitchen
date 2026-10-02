import type { z } from "zod";
import { FactoryWorkflowSchema, type WorkflowProfile } from "./factory-contracts.js";

export type RoleWorkflow = z.infer<typeof FactoryWorkflowSchema>;
export interface WorkflowConnection {
  id: string;
  board: string;
  from: string;
  to: string;
  label: string;
}
export function workflowConnections(workflow: RoleWorkflow): WorkflowConnection[] {
  return Object.entries(workflow.boards).flatMap(([boardId, board]) =>
    Object.entries(board.phases).flatMap(([phaseId, phase]) => {
      const targets = Object.entries(phase.outcomes || {});
      if (phase.next) targets.push(["next", phase.next]);
      if (phase.completeWithChildren)
        targets.push(["all child results verified", phase.completeWithChildren]);
      return targets.map(([label, target]) => ({
        id: `${boardId}:${phaseId}:${label}`,
        board: boardId,
        from: phaseId,
        to: target,
        label,
      }));
    }),
  );
}
export function roleReceivers(workflow: RoleWorkflow, role: string): string[] {
  const connections = workflowConnections(workflow);
  return [
    ...new Set(
      connections
        .filter((edge) => workflow.boards[edge.board].phases[edge.from].role === role)
        .map((edge) => {
          const target = workflow.boards[edge.board].phases[edge.to];
          return `${edge.label} → ${target?.role ? workflow.roles[target.role]?.title || target.role : target?.title || edge.to}`;
        }),
    ),
  ];
}
export function roleTemplate(workflow: RoleWorkflow, role: string, id: string): WorkflowProfile {
  const details = workflow.roles[role];
  const phases = Object.values(workflow.boards).flatMap((board) =>
    Object.values(board.phases).filter((phase) => phase.role === role),
  );
  const outcomes = [...new Set(phases.flatMap((phase) => Object.keys(phase.outcomes || {})))];
  return {
    id,
    name: details.title,
    targetRole: role,
    brief: {
      task: `Complete the ${details.title} work against the mission goal and acceptance criteria.`,
      responsibility: details.canEdit
        ? "Inspect the existing work, make scoped changes and record verifiable evidence."
        : "Independently inspect the assigned work and report concrete evidence without editing protected files.",
      outcome: `Provide a factory-report with an allowed outcome (${outcomes.join(", ")}) and evidence for the actual result.`,
    },
    profile: { instructions: details.instructions, skills: details.skills || [] },
  };
}
export function compatibleRoleProfile(profile: WorkflowProfile, role: string) {
  return !profile.targetRole || profile.targetRole === role;
}
