import { readAgentRoutingNotice, type AgentRoutingNotice } from "../agent-routing.js";
import { isPersonFacingOrigin, ORIGIN_LABEL } from "./projection-types.js";
import type { ScheduleSummary } from "./schedules.js";
import type { SidebarWorkspaceEntry } from "./projection-types.js";
import type { Agent, WorkspaceDescriptor } from "./projection-types.js";
import { isWorkspaceRootAgent } from "./projection-types.js";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "./projection-types.js";
import { extractJiraKeys } from "./jira.js";
import type { WorkspaceTopic } from "./projection-types.js";
import type { RelatedPullRequest } from "./projection-types.js";

export type ChecksStatus = "none" | "pending" | "success" | "failure";

export interface LeitstandPullRequest {
  number: number;
  url: string;
  title: string | null;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  checksStatus: ChecksStatus | null;
}

export interface LeitstandAgent {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  bucket: SidebarStateBucket;
  routingNotice?: AgentRoutingNotice;

  pendingPermission: { id: string; title: string } | null;
  lastError: string | null;

  lastActivityAt: Date;

  personFacing: boolean;
}

export interface LeitstandHandoff {
  agentId: string;
  kind: string;
  need: string | null;
  at: Date;
}

export interface LeitstandSession {
  key: string;
  serverId: string;
  workspaceId: string;
  projectViewKey: string;
  projectName: string;
  projectRootPath: string | null;
  name: string;
  branch: string | null;

  context: string | null;
  bucket: SidebarStateBucket;
  since: Date | null;

  topic: WorkspaceTopic | null;
  agents: LeitstandAgent[];

  pullRequests: LeitstandPullRequest[];

  attachedPullRequests: RelatedPullRequest[];
  jiraKeys: string[];

  doneAt: Date | null;

  handedBackAt: Date | null;
  handoff: LeitstandHandoff | null;
}

export interface LeitstandSchedule {
  key: string;
  serverId: string;
  schedule: ScheduleSummary;

  projectViewKey: string | null;
  projectName: string | null;
}

function agentLifecycleStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

const CLAUDE_MODEL = /^claude-(haiku|sonnet|opus|fable)-(\d+)-(\d+)(?:-\d{8})?$/;
const GPT_MODEL = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/;

export function formatModelLabel(modelId: string): string {
  const id = modelId.slice(modelId.lastIndexOf("/") + 1);
  const claude = CLAUDE_MODEL.exec(id);
  if (claude) return `${capitalize(claude[1]!)} ${claude[2]}.${claude[3]}`;
  const gpt = GPT_MODEL.exec(id);
  if (gpt) return gpt[2] ? `GPT-${gpt[1]} ${capitalize(gpt[2])}` : `GPT-${gpt[1]}`;
  return id;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function toLeitstandAgent(agent: Agent): LeitstandAgent {
  const permission = agent.pendingPermissions[0];
  const routingNotice = readAgentRoutingNotice(agent);
  const blocked = routingNotice?.status === "waiting" || routingNotice?.status === "exhausted";
  return {
    id: agent.id,
    title: agent.title,
    provider: agent.provider,
    model: agent.model ? formatModelLabel(agent.model) : null,
    routingNotice,
    bucket: blocked
      ? "needs_input"
      : deriveSidebarStateBucket({
          status: agentLifecycleStatus(agent),
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
        }),
    pendingPermission: permission
      ? { id: permission.id, title: permission.title ?? permission.name }
      : null,
    lastError: agent.lastError ?? null,
    lastActivityAt: agent.lastActivityAt,
    personFacing: isPersonFacingOrigin(agent.labels[ORIGIN_LABEL]),
  };
}

export function groupRootAgentsByWorkspace(
  agents: Iterable<Agent>,
  includeChildren = false,
): Map<string, LeitstandAgent[]> {
  const byId = new Map<string, Agent>();
  for (const agent of agents) byId.set(agent.id, agent);
  const grouped = new Map<string, LeitstandAgent[]>();
  for (const agent of byId.values()) {
    if (agent.archivedAt || !agent.workspaceId) continue;
    const parent = agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined;
    if (!includeChildren && !isWorkspaceRootAgent(agent, parent)) continue;
    const list = grouped.get(agent.workspaceId) ?? [];
    const projected = toLeitstandAgent(agent);
    if (includeChildren) projected.personFacing = true;
    list.push(projected);
    grouped.set(agent.workspaceId, list);
  }
  return grouped;
}

export function selectSessionPullRequests(
  entry: Pick<SidebarWorkspaceEntry, "prHint" | "relatedPullRequests">,
  githubRuntime: WorkspaceDescriptor["githubRuntime"],
): LeitstandPullRequest[] {
  const related = entry.relatedPullRequests ?? [];
  if (related.length > 0) {
    return related
      .map((pr, index) => ({ pr, order: pr.stackIndex ?? related.length + index }))
      .sort((left, right) => left.order - right.order)
      .map(({ pr }) => ({
        number: pr.number,
        url: pr.url,
        title: pr.title ?? null,
        state: pr.state,
        isDraft: pr.isDraft ?? false,
        checksStatus: pr.checksStatus ?? null,
      }));
  }
  const hint = entry.prHint;
  if (!hint) return [];
  const current = githubRuntime?.pullRequest;
  return [
    {
      number: hint.number,
      url: hint.url,
      title: current?.title ?? null,
      state: hint.state,
      isDraft: current?.isDraft ?? false,
      checksStatus: hint.checksStatus ?? null,
    },
  ];
}

function latest(dates: readonly Date[]): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (!result || date.getTime() > result.getTime()) result = date;
  }
  return result;
}

function toHandoff(handoff: WorkspaceDescriptor["handoff"]): LeitstandHandoff | null {
  if (!handoff) return null;
  const at = new Date(handoff.at);
  return Number.isFinite(at.getTime()) ? { ...handoff, at } : null;
}

export function buildLeitstandSession(input: {
  entry: SidebarWorkspaceEntry;
  githubRuntime: WorkspaceDescriptor["githubRuntime"];
  agents: readonly LeitstandAgent[];
  topic?: WorkspaceTopic | null;
  doneAt?: string | null;
  handoff?: WorkspaceDescriptor["handoff"];
}): LeitstandSession {
  const { entry } = input;
  const pullRequests = selectSessionPullRequests(entry, input.githubRuntime);
  const doneAt = input.doneAt ? new Date(input.doneAt) : null;
  return {
    key: entry.workspaceKey,
    serverId: entry.serverId,
    workspaceId: entry.workspaceId,
    projectViewKey: entry.projectViewKey,
    projectName: entry.projectName,
    projectRootPath: entry.projectRootPath ?? null,
    name: entry.name,
    branch: entry.currentBranch,
    context: entry.currentBranch,
    bucket: input.agents.some(
      (agent) =>
        agent.routingNotice?.status === "waiting" || agent.routingNotice?.status === "exhausted",
    )
      ? "needs_input"
      : entry.statusBucket,
    since: entry.statusEnteredAt,
    topic: input.topic ?? null,
    agents: [...input.agents],
    pullRequests,
    attachedPullRequests: (entry.relatedPullRequests ?? []).filter((pr) => pr.origin === "manual"),
    doneAt: doneAt && Number.isFinite(doneAt.getTime()) ? doneAt : null,
    handedBackAt: latest(input.agents.map((agent) => agent.lastActivityAt)),
    handoff: toHandoff(input.handoff),
    jiraKeys: extractJiraKeys([
      entry.name,
      entry.currentBranch,
      ...pullRequests.map((pr) => pr.title),
    ]),
  };
}

function isInsideRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function resolveScheduleProject(
  input: { serverId: string; schedule: ScheduleSummary },
  sessions: readonly LeitstandSession[],
): Pick<LeitstandSchedule, "projectViewKey" | "projectName"> {
  const target = input.schedule.target;
  const onHost = sessions.filter((session) => session.serverId === input.serverId);
  const match =
    target.type === "agent"
      ? onHost.find((session) => session.agents.some((agent) => agent.id === target.agentId))
      : onHost.find(
          (session) =>
            session.projectRootPath !== null &&
            isInsideRoot(target.config.cwd, session.projectRootPath),
        );
  return match
    ? { projectViewKey: match.projectViewKey, projectName: match.projectName }
    : { projectViewKey: null, projectName: null };
}

export type BoardColumnId = "running" | "waiting" | "planned" | "done";

export type SessionColumn = "running" | "waiting" | "done";

export interface LeitstandBoard {
  running: LeitstandSession[];
  waiting: LeitstandSession[];
  planned: LeitstandSchedule[];
  done: LeitstandSession[];
}

export function isSessionMarkedDone(session: LeitstandSession): boolean {
  if (!session.doneAt) return false;
  return !session.handedBackAt || session.doneAt.getTime() >= session.handedBackAt.getTime();
}

export function sessionColumn(session: LeitstandSession): SessionColumn {
  if (session.bucket === "running") return "running";
  return isSessionMarkedDone(session) ? "done" : "waiting";
}

function newestFirst(left: LeitstandSession, right: LeitstandSession): number {
  return (right.since?.getTime() ?? 0) - (left.since?.getTime() ?? 0);
}

function nextRunTime(schedule: LeitstandSchedule): number {
  return schedule.schedule.nextRunAt ? Date.parse(schedule.schedule.nextRunAt) : Infinity;
}

export function buildLeitstandBoard(input: {
  sessions: readonly LeitstandSession[];
  schedules: readonly LeitstandSchedule[];
  projectViewKey: string | null;
}): LeitstandBoard {
  const inProject = (key: string | null) =>
    input.projectViewKey === null || key === input.projectViewKey;
  const sessions = input.sessions.filter((session) => inProject(session.projectViewKey));
  const inColumn = (column: SessionColumn) =>
    sessions.filter((session) => sessionColumn(session) === column).sort(newestFirst);
  return {
    running: inColumn("running"),
    waiting: inColumn("waiting"),
    done: inColumn("done"),
    planned: input.schedules
      .filter(
        (entry) =>
          entry.schedule.status === "active" &&
          entry.schedule.nextRunAt !== null &&
          inProject(entry.projectViewKey),
      )
      .sort((left, right) => nextRunTime(left) - nextRunTime(right)),
  };
}

export function projectMonogram(projectName: string): string {
  const [first = projectName, second] = projectName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2);
  return letters.toUpperCase();
}

export interface PullRequestStack {
  merged: number;
  total: number;
}

export function summarizeStack(pullRequests: readonly LeitstandPullRequest[]): PullRequestStack {
  return {
    merged: pullRequests.filter((pr) => pr.state === "merged").length,
    total: pullRequests.length,
  };
}

export type LeitstandBoardEntry =
  | { kind: "session"; session: LeitstandSession }
  | {
      kind: "topic";
      key: string;
      topic: WorkspaceTopic;

      children: LeitstandSession[];
      bucket: SidebarStateBucket;
      column: SessionColumn;
      since: Date | null;
    };

const BUCKET_URGENCY: Record<SidebarStateBucket, number> = {
  failed: 0,
  needs_input: 1,
  running: 2,
  attention: 3,
  done: 4,
};

const COLUMN_URGENCY: Record<SessionColumn, number> = { waiting: 0, running: 1, done: 2 };

export function arrangeBoardColumns(
  board: LeitstandBoard,
): Record<SessionColumn, LeitstandBoardEntry[]> {
  const topics = new Map<string, Extract<LeitstandBoardEntry, { kind: "topic" }>>();
  const loose: LeitstandSession[] = [];
  for (const session of [...board.running, ...board.waiting, ...board.done]) {
    if (!session.topic) {
      loose.push(session);
      continue;
    }
    const key = `${session.serverId}:${session.topic.id}`;
    const group = topics.get(key) ?? {
      kind: "topic" as const,
      key,
      topic: session.topic,
      children: [],
      bucket: session.bucket,
      column: sessionColumn(session),
      since: session.since,
    };
    group.children.push(session);
    if (BUCKET_URGENCY[session.bucket] < BUCKET_URGENCY[group.bucket])
      group.bucket = session.bucket;
    const column = sessionColumn(session);
    if (COLUMN_URGENCY[column] < COLUMN_URGENCY[group.column]) group.column = column;
    if ((session.since?.getTime() ?? 0) > (group.since?.getTime() ?? 0))
      group.since = session.since;
    topics.set(key, group);
  }
  for (const group of topics.values()) {
    group.children.sort(
      (left, right) => BUCKET_URGENCY[left.bucket] - BUCKET_URGENCY[right.bucket],
    );
  }
  const entries: LeitstandBoardEntry[] = [
    ...loose.map((session) => ({ kind: "session" as const, session })),
    ...topics.values(),
  ];
  const columnOf = (entry: LeitstandBoardEntry) =>
    entry.kind === "session" ? sessionColumn(entry.session) : entry.column;
  const sinceOf = (entry: LeitstandBoardEntry) =>
    (entry.kind === "session" ? entry.session.since : entry.since)?.getTime() ?? 0;
  const inColumn = (column: SessionColumn) =>
    entries
      .filter((entry) => columnOf(entry) === column)
      .sort((left, right) => sinceOf(right) - sinceOf(left));
  return { running: inColumn("running"), waiting: inColumn("waiting"), done: inColumn("done") };
}
