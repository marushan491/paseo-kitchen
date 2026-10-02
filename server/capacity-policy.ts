import { AgentCapacitySchema, DEFAULT_AGENT_CAPACITY } from "../shared/preferences.js";

export function resolveAgentCapacity(configured?: number): number {
  const result = AgentCapacitySchema.safeParse(configured ?? DEFAULT_AGENT_CAPACITY);
  if (!result.success) throw new Error("Factory concurrency must be a positive safe integer");
  return result.data;
}
