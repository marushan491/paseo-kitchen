import type { TeamState } from "../factory-contracts.js";

export function kitchenAgentIds(teams: readonly TeamState[]): string[] {
  return [
    ...new Set(
      teams
        .flatMap((state) => [
          state.team.bossAgentId,
          state.team.kitchen?.sourceAgentId,
          ...Object.values(state.bindings).map((binding) => binding.agentId),
        ])
        .filter((id): id is string => Boolean(id)),
    ),
  ].sort();
}

export function kitchenHumanRequests(teams: readonly TeamState[], projectPath?: string) {
  return teams
    .filter(
      (state) =>
        !["done", "canceled"].includes(state.team.status) &&
        (!projectPath ||
          state.team.cwd === projectPath ||
          state.team.cwd.startsWith(projectPath + "/")),
    )
    .flatMap((state) =>
      Object.values(state.items)
        .filter(
          (item) =>
            item.phase === "blocked" ||
            (item.id === state.team.rootItemId && item.phase === "ready-for-human"),
        )
        .map((item) => ({
          state,
          item,
          id: `${state.team.id}:${item.id}:human:${item.revision}`,
          ready: item.phase === "ready-for-human",
          reason:
            item.phase === "ready-for-human"
              ? "Review the verified result and accept it when it meets your goal."
              : item.reports.at(-1)?.summary ||
                "The mission needs clarification. Open it to inspect the question and reply.",
        })),
    );
}
