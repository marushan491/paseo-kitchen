import type { RoleProfileOverride } from "../shared/factory-contracts.js";

export function resolveWorkflowSteps(
  initial: RoleProfileOverride["steps"],
  text: string,
  edited: boolean,
): RoleProfileOverride["steps"] {
  if (!edited) return initial;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((instructions, index) => ({
      id: `step-${index + 1}`,
      title: instructions.slice(0, 100),
      instructions,
    }));
}
