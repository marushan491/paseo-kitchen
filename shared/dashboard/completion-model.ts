import type { TeamState } from "../factory-contracts.js";

export interface CompletionAgent {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  status?: string;
  turn?: { phase?: string };
}
export function kitchenCompletionByWorkspace(
  teams: TeamState[],
  agents: CompletionAgent[],
  serverId: string,
) {
  const workspaceByAgent = new Map(agents.map((agent) => [agent.id, agent.workspaceId]));
  const workspaceOf = (state: TeamState) =>
    workspaceByAgent.get(state.team.bossAgentId) ||
    workspaceByAgent.get(state.team.kitchen?.sourceAgentId || "");
  const active = new Set(
    teams
      .filter((state) => !["done", "canceled"].includes(state.team.status))
      .map(workspaceOf)
      .filter(Boolean),
  );
  for (const agent of agents)
    if (
      !agent.archivedAt &&
      (agent.turn?.phase === "open" || agent.status === "running") &&
      agent.workspaceId
    )
      active.add(agent.workspaceId);
  const completed: Record<string, string> = {};
  for (const state of teams) {
    const workspaceId = workspaceOf(state);
    const acceptedAt = state.team.kitchen?.acceptedAt;
    if (
      !workspaceId ||
      active.has(workspaceId) ||
      state.team.status !== "done" ||
      !acceptedAt ||
      !Number.isFinite(Date.parse(acceptedAt))
    )
      continue;
    const key = `${serverId}:${workspaceId}`;
    if (!completed[key] || acceptedAt > completed[key]) completed[key] = acceptedAt;
  }
  return completed;
}
