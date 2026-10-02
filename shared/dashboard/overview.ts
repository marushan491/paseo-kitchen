import type { InboxItem } from "./inbox-model.js";

export function partitionInbox(items: InboxItem[]) {
  return {
    needsYou: items.filter((item) => !isProblem(item)),
    problems: items.filter(isProblem),
  };
}

function isProblem(item: InboxItem) {
  return (
    item.kind === "agent_error" || item.kind === "schedule_error" || item.kind === "checks_failed"
  );
}

export function recentCompletedSessions(
  sessions: import("./session-model.js").LeitstandSession[],
  limit = 3,
) {
  return sessions
    .slice()
    .sort((left, right) => completedAt(right) - completedAt(left))
    .slice(0, limit);
}

function completedAt(session: import("./session-model.js").LeitstandSession) {
  return (session.doneAt ?? session.handedBackAt ?? session.since)?.getTime() ?? 0;
}
