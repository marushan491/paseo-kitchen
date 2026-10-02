import { deriveAgentStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { PaseoAgent } from "@getpaseo/client";
export interface WorkspaceTopic {
  id: string;
  title: string;
  description: string | null;
}

export type SidebarStateBucket = "needs_input" | "failed" | "running" | "attention" | "done";
export const STATUS_BUCKET_ORDER: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "attention",
  "running",
  "done",
];
export const deriveSidebarStateBucket = deriveAgentStateBucket;
export const ORIGIN_LABEL = "paseo.origin";
export function isPersonFacingOrigin(origin: string | null | undefined): boolean {
  const value = origin?.trim();
  if (!value) return true;
  if (value.startsWith("paperclip:")) return value === "paperclip:Boss";
  return !["schedule", "systemd:", "process:", "internal"].some((prefix) =>
    value.startsWith(prefix),
  );
}

export interface Agent {
  id: string;
  provider: string;
  title: string | null;
  model: string | null;
  status: PaseoAgent["status"];
  turn: { phase: string; cancellationRequestId?: string | null };
  pendingPermissions: { id: string; title?: string | null; name: string }[];
  requiresAttention: boolean;
  attentionReason: PaseoAgent["attentionReason"];
  lastError: string | null;
  lastActivityAt: Date;
  labels: Record<string, string>;
  workspaceId: string | null;
  parentAgentId: string | null;
  archivedAt: Date | string | null;
  [key: string]: unknown;
}

export interface WorkspaceDescriptor {
  githubRuntime?: {
    pullRequest?: {
      number?: number;
      url: string;
      title: string;
      state: string;
      isMerged?: boolean;
      isDraft?: boolean;
      checksStatus?: "none" | "pending" | "success" | "failure";
      [key: string]: unknown;
    } | null;
    relatedPullRequests?: RelatedPullRequest[];
    [key: string]: unknown;
  } | null;
  handoff?: { agentId: string; kind: string; need: string | null; at: string } | null;
  doneAt?: string | null;
  topic?: WorkspaceTopic | null;
}

export interface RelatedPullRequest {
  number: number;
  url: string;
  title?: string;
  state: "open" | "merged" | "closed";
  isDraft?: boolean;
  checksStatus?: "none" | "pending" | "success" | "failure";
  origin: "stack" | "branch" | "current" | "manual";
  stackIndex?: number;
  [key: string]: unknown;
}

export interface SidebarWorkspaceEntry {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  projectViewKey: string;
  projectName: string;
  projectRootPath: string | null;
  name: string;
  currentBranch: string | null;
  statusBucket: SidebarStateBucket;
  statusEnteredAt: Date | null;
  prHint: {
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    checksStatus?: "none" | "pending" | "success" | "failure" | null;
  } | null;
  relatedPullRequests: RelatedPullRequest[];
  [key: string]: unknown;
}

export function isWorkspaceRootAgent(
  agent: Pick<Agent, "parentAgentId" | "workspaceId">,
  parent: Pick<Agent, "workspaceId"> | undefined,
): boolean {
  if (!agent.parentAgentId) return true;
  return Boolean(
    agent.workspaceId && parent?.workspaceId && agent.workspaceId !== parent.workspaceId,
  );
}
