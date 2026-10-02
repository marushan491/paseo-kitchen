import type { TeamEvent, TeamState } from "./factory-contracts.js";
import { stageTitle, type MissionWorkflow } from "./mission-stage.js";

export interface MissionActivity {
  id: string;
  at: string;
  title: string;
  description: string;
}

function phaseActivityTitle(
  event: TeamEvent,
  state: TeamState,
  workflow?: MissionWorkflow,
): string | null {
  const item = event.workItemId ? state.items[event.workItemId] : undefined;
  const phaseId = event.data?.to;
  if (!item || typeof phaseId !== "string") return null;
  if (phaseId === "ready-for-human")
    return item.id === state.team.rootItemId
      ? "Result ready for your review"
      : "Task verification finished";
  if (phaseId === "blocked") return "Kitchen needs your decision";
  if (phaseId === "done") return "Task completed";
  const definition = workflow?.boards[item.board]?.phases[phaseId];
  if (definition?.kind !== "working") return null;
  return `Entered ${stageTitle(state.team.packId, item.board, phaseId, definition.title)}`;
}
function reportActivityTitle(
  event: TeamEvent,
  state: TeamState,
  workflow?: MissionWorkflow,
): string {
  const item = event.workItemId ? state.items[event.workItemId] : undefined;
  const bindingId = event.data?.bindingId;
  const binding = typeof bindingId === "string" ? state.bindings[bindingId] : undefined;
  const definition =
    item && binding ? workflow?.boards[item.board]?.phases[binding.phase] : undefined;
  const stage =
    item && binding
      ? stageTitle(state.team.packId, item.board, binding.phase, definition?.title || "Agent")
      : "Agent";
  if (event.data?.outcome === "fail" || event.data?.outcome === "changes")
    return `${stage} requested corrections`;
  return `${stage} report received`;
}
function activityTitle(
  event: TeamEvent,
  state: TeamState,
  workflow?: MissionWorkflow,
): string | null {
  if (event.type === "item.phase") return phaseActivityTitle(event, state, workflow);
  if (event.type === "report.accepted") return reportActivityTitle(event, state, workflow);
  const titles: Record<string, string> = {
    "team.started": "Mission started",
    "team.accepted": "You accepted the result",
    "team.done": "Mission completed",
    "team.paused": "Mission paused",
    "team.active": "Mission resumed",
    "team.canceled": "Mission canceled",
    "human.message": "You replied",
    "boss.notified": "Head Chef received a request",
    "decision.failed": "Execution needs attention",
    "decision.retried": "Execution retry requested",
    "report.rejected": "Agent report needs correction",
  };
  return titles[event.type] ?? null;
}

export function missionActivity(
  state: TeamState,
  events: readonly TeamEvent[],
  workflow?: MissionWorkflow,
  limit = 12,
): MissionActivity[] {
  return events
    .flatMap((event) => {
      const title = activityTitle(event, state, workflow);
      return title
        ? [{ id: event.id, at: event.at, title, description: event.text.slice(0, 600) }]
        : [];
    })
    .slice(-limit)
    .toReversed();
}
