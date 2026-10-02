import type {
  PluginLifecycleEvents,
  PluginServerContext,
  PluginHookContext,
} from "@getpaseo/plugin/server";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { TEAM_LABEL, TEAM_ROLE_LABEL } from "../shared/factory-contracts.js";
import {
  KITCHEN_SUGGESTION_ID,
  KITCHEN_SUGGESTION_KIND,
  readKitchenSuggestion,
} from "../shared/kitchen-suggestion.js";
import type { KitchenDecisionSource, SystemOneConfig, JevClassification } from "./system-one.js";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
interface MemberState {
  team: { bossAgentId: string; kitchen?: { sourceAgentId?: string } };
  bindings: Record<string, { agentId: string }>;
}
interface Options {
  config(): Promise<SystemOneConfig>;
  decisionSource: Pick<KitchenDecisionSource, "classify">;
  service(paseo: PaseoApi): Promise<{
    store: { listIds(): Promise<string[]>; get(id: string): Promise<MemberState | null> };
  }>;
}

const implementation =
  /\b(build|implement|create|develop|add|refactor|migrate|deliver|ship|umsetzen|umsetz|bauen|baue|entwickel\w*|implementier\w*|erstell\w*|erweit\w*|migrier\w*)\b/i;
const breadth =
  /\b(project|application|platform|product|roadmap|backlog|system|projekt|app|anwendung|plattform|features|website|plugin)\b/i;
const areas = [
  /\b(frontend|ui|dashboard)\b/i,
  /\b(backend|api)\b/i,
  /\b(database|datenbank)\b/i,
  /\b(auth\w*|login|permissions?|rollen)\b/i,
  /\b(billing|payments?)\b/i,
  /\b(deployment|migration|integration)\b/i,
  /\b(workflow\w*|mobile)\b/i,
];

export function suggestionObjective(timeline: TurnEnded["timeline"]): string | null {
  const messages = timeline
    .filter((item) => item.type === "user_message")
    .map((item) => item.text.trim())
    .filter((text) => text.length >= 20);
  const seed = messages.findIndex(
    (text) => text.length >= 80 && implementation.test(text) && text.split(/\s+/).length >= 10,
  );
  if (seed < 0) return null;
  const objective = messages
    .slice(seed, seed + 3)
    .join("\n\n")
    .slice(0, 4000);
  return breadth.test(objective) && areas.filter((area) => area.test(objective)).length >= 2
    ? objective
    : null;
}

function excluded(cwd: string, config: SystemOneConfig): boolean {
  const target = resolve(cwd);
  return Boolean(
    config.excludedPaths?.some((path) => {
      const part = relative(resolve(path.replace(/^~(?=$|\/)/, homedir())), target);
      return !part || (!part.startsWith("..") && !isAbsolute(part));
    }),
  );
}

function ordinarySnapshot(snapshot: PaseoAgent | null, agent: TurnEnded["agent"]): boolean {
  return Boolean(
    snapshot &&
    !snapshot.archivedAt &&
    snapshot.workspaceId === agent.workspaceId &&
    snapshot.cwd === agent.cwd &&
    !snapshot.labels[TEAM_LABEL] &&
    !snapshot.labels[TEAM_ROLE_LABEL],
  );
}

function completedRoot(event: TurnEnded): boolean {
  return (
    event.outcome.kind === "completed" &&
    !event.agent.parentAgentId &&
    Boolean(event.agent.workspaceId)
  );
}

function confidentTeam(result: JevClassification, config: SystemOneConfig): boolean {
  return (
    result.executionMode === "team" &&
    result.confidence >= Math.max(0.7, config.minimumConfidence ?? 0.5)
  );
}

async function isMember(agentId: string, store: Awaited<ReturnType<Options["service"]>>["store"]) {
  for (const id of await store.listIds()) {
    const state = await store.get(id);
    if (
      state &&
      (state.team.bossAgentId === agentId ||
        state.team.kitchen?.sourceAgentId === agentId ||
        Object.values(state.bindings).some((binding) => binding.agentId === agentId))
    )
      return true;
  }
  return false;
}

export function registerKitchenSuggestions(server: PluginServerContext, options: Options) {
  if (typeof server.on !== "function" || process.env.KITCHEN_SUGGESTIONS_ENABLED === "false")
    return () => {};
  const attempted = new Set<string>();
  const pending = new Set<string>();
  let disposed = false;
  const offer = async (
    event: TurnEnded,
    { paseo, signal }: PluginHookContext,
    objective: string,
  ) => {
    const { agent } = event;
    pending.add(agent.id);
    try {
      const config = await options.config();
      if (!config.enabled || excluded(agent.cwd, config)) return;
      const handle = paseo.agents.ref(agent.id);
      if (typeof handle.timeline?.append !== "function") return;
      const snapshot = (await handle.refresh())?.agent ?? null;
      if (!ordinarySnapshot(snapshot, agent)) return;
      const { store } = await options.service(paseo);
      if (await isMember(agent.id, store)) return;
      if (disposed || signal.aborted) return;
      attempted.add(agent.id);
      const title = objective.split("\n")[0]!.slice(0, 160);
      const result = await options.decisionSource.classify({
        title,
        objective,
        cwd: agent.cwd,
        provider: agent.provider,
        sourceAgentId: agent.id,
        workspaceId: agent.workspaceId!,
        acceptanceCriteria: [],
        idempotencyKey: `suggestion:${agent.id}`,
        executionMode: "auto",
      });
      if (disposed || signal.aborted || !confidentTeam(result, config)) return;
      const current = (await handle.refresh())?.agent ?? null;
      if (!ordinarySnapshot(current, agent) || (await isMember(agent.id, store))) return;
      await handle.timeline.append({
        type: "plugin",
        id: KITCHEN_SUGGESTION_ID,
        kind: KITCHEN_SUGGESTION_KIND,
        version: 1,
        data: {
          source: "paseo-kitchen",
          sourceAgentId: agent.id,
          workspaceId: agent.workspaceId,
          cwd: agent.cwd,
          title,
          objective,
          confidence: result.confidence,
          reason:
            "This goal has several connected pieces. Kitchen can coordinate planning, implementation, review and verification.",
        },
      });
    } catch {
      return;
    } finally {
      pending.delete(agent.id);
    }
  };
  const remove = server.on("agent.turn_ended", async (event, context) => {
    const { agent } = event;
    if (
      disposed ||
      context.signal.aborted ||
      !completedRoot(event) ||
      attempted.has(agent.id) ||
      pending.has(agent.id) ||
      readKitchenSuggestion(event.timeline, agent.id)
    )
      return;
    const objective = suggestionObjective(event.timeline);
    if (objective) await offer(event, context, objective);
  });
  return () => {
    disposed = true;
    remove();
    pending.clear();
    attempted.clear();
  };
}
