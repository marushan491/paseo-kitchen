import { readAgentRoutingNotice } from "../../shared/agent-routing.js";
import type { PaseoApi, PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  buildLeitstandSession,
  groupRootAgentsByWorkspace,
  type LeitstandSession,
} from "../../shared/dashboard/session-model.js";
import { STATUS_BUCKET_ORDER } from "../../shared/dashboard/projection-types.js";
import type { Agent, WorkspaceDescriptor } from "../../shared/dashboard/projection-types.js";
import type { Preferences } from "../../shared/dashboard/contracts.js";

const metadataSchema = z.object({
  doneAt: z.string().nullable().optional(),
  handoff: z
    .object({ agentId: z.string(), kind: z.string(), need: z.string().nullable(), at: z.string() })
    .nullable()
    .optional(),
  topic: z
    .object({ id: z.string(), title: z.string(), description: z.string().nullable() })
    .nullable()
    .optional(),
});
const agentMetadataSchema = z.object({
  turn: z.object({ phase: z.string() }).optional(),
  lastActivityAt: z.string().optional(),
  parentAgentId: z.string().nullable().optional(),
});

export interface HostInventory {
  serverId: string;
  label: string;
  workspaces: PaseoWorkspace[];
  agents: PaseoAgent[];
  error: string | null;
  complete: boolean;
}

export async function readDirectory(api: PaseoApi, agentIds: readonly string[]) {
  const agents: PaseoAgent[] = [];
  for (let offset = 0; offset < agentIds.length; offset += 8) {
    const results = await Promise.all(
      agentIds.slice(offset, offset + 8).map((id) => api.agents.ref(id).refresh()),
    );
    agents.push(...results.flatMap((entry) => (entry ? [entry.agent] : [])));
  }
  const workspaceIds = [
    ...new Set(agents.flatMap((agent) => (agent.workspaceId ? [agent.workspaceId] : []))),
  ];
  const workspaces: PaseoWorkspace[] = [];
  for (let offset = 0; offset < workspaceIds.length; offset += 8) {
    const results = await Promise.all(
      workspaceIds.slice(offset, offset + 8).map((id) => api.workspaces.ref(id).refresh()),
    );
    workspaces.push(...results.flatMap((entry) => (entry ? [entry] : [])));
  }
  return { workspaces, agents, complete: true };
}

export function useDirectory(
  props: PluginSurfaceProps,
  agentIds: readonly string[],
  ready: boolean,
) {
  const own = usePaseo();
  const [inventories, setInventories] = useState<HostInventory[]>([]);
  const [loading, setLoading] = useState(true);
  const membership = JSON.stringify(agentIds);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    setInventories([]);
    setLoading(true);
    if (!ready) return;
    const ids: string[] = JSON.parse(membership);
    const changed = () => {
      void refresh();
    };
    async function refresh() {
      if (disposed || pending) return;
      pending = true;
      let next: HostInventory;
      try {
        next = {
          serverId: props.host.id,
          label: props.host.label,
          ...(await readDirectory(own, ids)),
          error: null,
        };
      } catch (error) {
        next = {
          serverId: props.host.id,
          label: props.host.label,
          workspaces: [],
          agents: [],
          complete: false,
          error: error instanceof Error ? error.message : "Kitchen agents unavailable",
        };
      } finally {
        pending = false;
      }
      if (!disposed) {
        setInventories([next]);
        setLoading(false);
      }
    }
    const release = own.agents.subscribe((event) => {
      if (event.kind === "remove" ? ids.includes(event.agentId) : ids.includes(event.agent.id))
        changed();
    });
    const timer = ids.length ? setInterval(changed, 4000) : undefined;
    void refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
      release();
    };
  }, [own, membership, ready, props.host.id, props.host.label]);
  return { inventories, loading };
}

function projectionAgent(agent: PaseoAgent): Agent {
  const metadata = agentMetadataSchema.parse(agent);
  return {
    id: agent.id,
    provider: agent.provider,
    title: agent.title ?? null,
    model: agent.model ?? null,
    status: agent.status,
    routingNotice: readAgentRoutingNotice(agent),
    turn: metadata.turn ?? { phase: agent.activeTurn ? "open" : "idle" },
    pendingPermissions: agent.pendingPermissions,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason,
    lastError: agent.lastError ?? null,
    lastActivityAt: new Date(metadata.lastActivityAt ?? agent.updatedAt),
    labels: { ...agent.labels },
    workspaceId: agent.workspaceId ?? null,
    parentAgentId: metadata.parentAgentId ?? agent.labels["paseo.parent-agent-id"] ?? null,
    archivedAt: agent.archivedAt ?? null,
  };
}

export function projectInventory(
  inventory: HostInventory,
  preferences: Preferences,
): LeitstandSession[] {
  const grouped = groupRootAgentsByWorkspace(inventory.agents.map(projectionAgent), true);
  return inventory.workspaces
    .filter((workspace) => !workspace.archivingAt)
    .map((workspace) => {
      const members = grouped.get(workspace.id) ?? [];
      const key = `${inventory.serverId}:${workspace.id}`;
      const metadata = metadataSchema.parse(workspace);
      const githubRuntime = workspace.githubRuntime as WorkspaceDescriptor["githubRuntime"];
      const current = githubRuntime?.pullRequest;
      const state = current?.isMerged ? "merged" : current?.state.toLowerCase();
      return buildLeitstandSession({
        entry: {
          workspaceKey: key,
          serverId: inventory.serverId,
          workspaceId: workspace.id,
          projectViewKey: `${inventory.serverId}:${workspace.projectId}`,
          projectName: workspace.projectDisplayName,
          projectRootPath: workspace.projectRootPath,
          name: workspace.name,
          currentBranch: workspace.gitRuntime?.currentBranch ?? null,
          statusBucket:
            STATUS_BUCKET_ORDER.find((bucket) =>
              members.some((agent) => agent.bucket === bucket),
            ) ?? "done",
          statusEnteredAt: workspace.statusEnteredAt ? new Date(workspace.statusEnteredAt) : null,
          prHint:
            current?.number && (state === "open" || state === "merged" || state === "closed")
              ? {
                  number: current.number,
                  url: current.url,
                  state,
                  checksStatus: current.checksStatus,
                }
              : null,
          relatedPullRequests: githubRuntime?.relatedPullRequests ?? [],
        },
        githubRuntime,
        agents: members,
        doneAt: Object.hasOwn(preferences.doneAt, key) ? preferences.doneAt[key] : metadata.doneAt,
        handoff: metadata.handoff as WorkspaceDescriptor["handoff"],
        topic: metadata.topic,
      });
    });
}

export function useSessions(inventories: HostInventory[], preferences: Preferences) {
  return useMemo(
    () => inventories.flatMap((inventory) => projectInventory(inventory, preferences)),
    [inventories, preferences],
  );
}
