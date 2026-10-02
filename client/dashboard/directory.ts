import { readAgentRoutingNotice } from "../../shared/agent-routing.js";
import type { PaseoApi, PaseoAgent, PaseoWorkspace, PaseoAgentListResult } from "@getpaseo/client";
import {
  getPaseoClient,
  useHosts,
  usePaseo,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  buildLeitstandSession,
  groupRootAgentsByWorkspace,
  type LeitstandSession,
} from "../../shared/dashboard/session-model.js";
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

export async function readDirectory(
  api: PaseoApi,
  keep: (release: () => Promise<void>) => void,
  subscribe = true,
) {
  const workspaces: PaseoWorkspace[] = [];
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await api.workspaces.list({
      page: { limit: 200, cursor },
      ...(page === 0 && subscribe ? { subscribe: {} } : {}),
    });
    if (result.subscription) keep(() => result.subscription!.release());
    workspaces.push(...result.entries);
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!cursor) break;
  }
  const workspacesComplete = !cursor;
  cursor = undefined;
  for (let page = 0; page < 10; page++) {
    const result: PaseoAgentListResult = await api.agents.list({
      page: { limit: 200, cursor },
      ...(page === 0 && subscribe ? { subscribe: {} } : {}),
    });
    if (result.subscription) keep(() => result.subscription!.release());
    agents.push(...result.entries.map((entry) => entry.agent));
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return { workspaces, agents, complete: workspacesComplete && !cursor };
}

export function useDirectory(props: PluginSurfaceProps) {
  const own = usePaseo();
  const hosts = useHosts();
  const [inventories, setInventories] = useState<HostInventory[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let queued = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let releases: (() => Promise<void>)[] = [];
    const configured = hosts.length
      ? hosts
      : [{ serverId: props.host.id, label: props.host.label, status: "online" as const }];
    const clients = configured.map((host) => {
      try {
        return { host, api: host.serverId === props.host.id ? own : getPaseoClient(host.serverId) };
      } catch {
        return { host, api: null };
      }
    });
    async function refresh() {
      if (disposed) return;
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      queued = false;
      const nextReleases: (() => Promise<void>)[] = [];
      const next = await Promise.all(
        clients.map(async ({ host, api }): Promise<HostInventory> => {
          const initial = {
            serverId: host.serverId,
            label: host.label,
            workspaces: [],
            agents: [],
            complete: false,
          };
          if (!api || host.status !== "online")
            return { ...initial, error: `Host ${host.label} is ${host.status}` };
          try {
            const directory = await readDirectory(
              api,
              (release) => nextReleases.push(release),
              releases.length === 0,
            );
            return { ...initial, ...directory, error: null };
          } catch (error) {
            return {
              ...initial,
              error: error instanceof Error ? error.message : "Directory unavailable",
            };
          }
        }),
      );
      releases.push(...nextReleases);
      pending = false;
      if (disposed) {
        await Promise.all(releases.map((release) => release().catch(() => undefined)));
        return;
      }
      setInventories(next);
      setLoading(false);
      if (queued) void refresh();
    }
    const changed = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void refresh();
      }, 500);
    };
    const unsubscribe = clients.flatMap(({ api }) =>
      api ? [api.workspaces.subscribe(changed), api.agents.subscribe(changed)] : [],
    );
    const backstop = setInterval(changed, 30_000);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearInterval(backstop);
      unsubscribe.forEach((release) => release());
      void Promise.all(releases.map((release) => release().catch(() => undefined)));
    };
  }, [own, hosts, props.host.id, props.host.label]);
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
  const grouped = groupRootAgentsByWorkspace(inventory.agents.map(projectionAgent));
  return inventory.workspaces
    .filter((workspace) => !workspace.archivingAt)
    .map((workspace) => {
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
          statusBucket: workspace.status,
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
        agents: grouped.get(workspace.id) ?? [],
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
