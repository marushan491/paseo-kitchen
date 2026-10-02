import type { WorkflowPack } from "./pack.js";

export function workflowOf(pack: WorkflowPack) {
  return {
    maxParallel: pack.maxParallel,
    roles: Object.fromEntries(
      Object.entries(pack.roles).map(([id, role]) => [
        id,
        {
          title: role.title,
          instructions: role.instructions,
          skills: role.skills,
          canEdit: role.canEdit,
          workspace: role.workspace,
        },
      ]),
    ),
    boards: Object.fromEntries(
      Object.entries(pack.boards).map(([id, board]) => [
        id,
        {
          initialPhase: board.initialPhase,
          phases: Object.fromEntries(
            Object.entries(board.phases).map(([phaseId, phase]) => [
              phaseId,
              {
                title: phase.title,
                kind: phase.kind,
                role: phase.role,
                outcomes: phase.outcomes,
                next: phase.next,
                completeWithChildren: phase.completeWithChildren,
              },
            ]),
          ),
        },
      ]),
    ),
  };
}
