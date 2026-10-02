import type { PaseoAgent } from "@getpaseo/client";
import type { TeamState } from "../shared/factory-contracts.js";
import { readAgentRoutingNotice } from "../shared/agent-routing.js";

export type OfficeAgentSnapshot = Pick<
  PaseoAgent,
  "id" | "title" | "status" | "provider" | "model" | "requiresAttention" | "pendingPermissions"
> & { routingNotice?: unknown };

export interface OfficeDesk {
  id: string;
  teamId: string;
  teamTitle: string;
  agentId: string;
  bindingId?: string;
  role: string;
  title: string;
  workItem: string;
  phase: string;
  activity: string;
  provider: string;
  model: string | null;
  observed: boolean;
  tone: "active" | "attention" | "settled" | "unknown";
  lane: number;
  seat: number;
}

export function projectOffice(
  teams: readonly TeamState[],
  agents: Readonly<Record<string, OfficeAgentSnapshot>> = {},
): OfficeDesk[] {
  const desks: Omit<OfficeDesk, "lane" | "seat">[] = [];
  for (const state of [...teams].sort((a, b) => a.team.id.localeCompare(b.team.id))) {
    desks.push(headDesk(state, agents));
    for (const binding of Object.values(state.bindings).sort((a, b) => a.id.localeCompare(b.id))) {
      desks.push(workerDesk(state, binding, agents));
    }
  }
  const roles = [...new Set(desks.map((desk) => desk.role))].sort((a, b) => compareRoles(a, b));
  const seats = new Map<string, number>();
  return desks.map((desk) => {
    const seat = seats.get(desk.role) || 0;
    seats.set(desk.role, seat + 1);
    return Object.assign({}, desk, { lane: roles.indexOf(desk.role), seat });
  });
}

function headDesk(
  state: TeamState,
  agents: Readonly<Record<string, OfficeAgentSnapshot>>,
): Omit<OfficeDesk, "lane" | "seat"> {
  const root = state.items[state.team.rootItemId];
  const agent = agents[state.team.bossAgentId];
  return {
    id: `${state.team.id}:head-chef`,
    teamId: state.team.id,
    teamTitle: state.team.title,
    agentId: state.team.bossAgentId,
    role: "Head Chef",
    title: agent?.title || state.team.title,
    workItem: root?.title || state.team.title,
    phase: root?.phase || state.team.status,
    activity: agentActivity(agent, "Not observed"),
    provider: agent?.provider || "Not observed",
    model: agent?.model ?? null,
    observed: Boolean(agent),
    tone: agentTone(agent),
  };
}

function workerDesk(
  state: TeamState,
  binding: TeamState["bindings"][string],
  agents: Readonly<Record<string, OfficeAgentSnapshot>>,
): Omit<OfficeDesk, "lane" | "seat"> {
  const worker = agents[binding.agentId];
  const profile = binding.executedProfile ?? state.team.roleProfiles[binding.role];
  const item = state.items[binding.workItemId];
  return {
    id: `${state.team.id}:${binding.id}`,
    teamId: state.team.id,
    teamTitle: state.team.title,
    agentId: binding.agentId,
    bindingId: binding.id,
    role: binding.role,
    title: worker?.title || binding.role,
    workItem: item?.title || binding.workItemId,
    phase: binding.phase,
    activity:
      binding.status === "revoked" ? "Binding revoked" : agentActivity(worker, binding.turn),
    provider: worker?.provider || profile?.provider || "Not observed",
    model: worker ? worker.model : profile?.model || null,
    observed: Boolean(worker),
    tone: binding.status === "revoked" ? "settled" : agentTone(worker),
  };
}

function compareRoles(a: string, b: string) {
  if (a === b) return 0;
  if (a === "Head Chef") return -1;
  if (b === "Head Chef") return 1;
  return a.localeCompare(b);
}

export function officeToneColor(
  tone: OfficeDesk["tone"],
  palette: { danger: string; accent: string; muted: string },
) {
  if (tone === "attention") return palette.danger;
  if (tone === "active") return palette.accent;
  return palette.muted;
}

function agentTone(agent: OfficeAgentSnapshot | undefined): OfficeDesk["tone"] {
  if (!agent) return "unknown";
  const notice = readAgentRoutingNotice(agent);
  if (notice?.status === "waiting" || notice?.status === "exhausted") return "attention";
  if (agent.status === "error" || agent.requiresAttention || agent.pendingPermissions.length)
    return "attention";
  if (agent.status === "running" || agent.status === "initializing") return "active";
  return "settled";
}

function agentActivity(agent: OfficeAgentSnapshot | undefined, fallback: string): string {
  const notice = readAgentRoutingNotice(agent);
  if (notice?.status === "waiting") return `Waiting: ${notice.reason}`;
  if (notice?.status === "exhausted") return `Exhausted: ${notice.reason}`;
  return agent?.status || fallback;
}

export function officeAgentIds(teams: readonly TeamState[]): string[] {
  return [...new Set(projectOffice(teams).map((desk) => desk.agentId))].sort();
}

export function officePosition(desk: Pick<OfficeDesk, "lane" | "seat">) {
  return { x: desk.seat * 3.4, z: desk.lane * 4.2 };
}
