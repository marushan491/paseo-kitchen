import type { PaseoApi, PaseoAgentConfig, PaseoAgentHandle } from "@getpaseo/client";
import type { AgentPromptInput } from "@getpaseo/protocol/agent-types";
import type {
  PluginHookContext,
  PluginHookAgent,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RoleProfileOverride } from "../shared/factory-contracts.js";
import {
  factoryNativePresets,
  factoryNativeStart,
  KITCHEN_MISSION_KIND,
  type NativeStart,
} from "../shared/native-contracts.js";
import { headChefConfig, nativePresets } from "./native-presets.js";
import { readProjectProfile, mergeWorkflowProfiles, type TeamService } from "./service.js";

interface AcceptedMessage {
  agent: PluginHookAgent;
  messageId: string;
  text: string;
  prompt: AgentPromptInput;
  origin: "client" | "plugin" | "unknown";
}
type NativeHost = PluginServerContext & {
  supportsLifecycleEvent?(name: string): boolean;
  supportsBeforeHookOrigin?(name: string): boolean;
};
const unavailable =
  "Update the host to use Kitchen in the native composer. The daemon needs accepted-message lifecycle and trusted agent-creation origin support.";

export function promptReferences(prompt: AgentPromptInput) {
  if (typeof prompt === "string") return {};
  return {
    attachments: prompt.map((block, index) =>
      block.type === "image" ? { type: block.type, mimeType: block.mimeType, index } : block,
    ),
  };
}

async function projectCatalog(service: TeamService, cwd: string) {
  const project = await service.listProjectPacks(cwd);
  const packs = [];
  for (const pack of project.packs)
    if (!pack.matches || (await pack.matches(cwd))) packs.push(pack);
  const catalog = nativePresets(packs, project.workflows, {
    workflowPack: project.defaultPackId,
    workflowId: project.defaultWorkflowId,
  });
  return { project, catalog };
}

function nativeRouting(mode: NativeStart["routingMode"], profile: RoleProfileOverride) {
  if (profile.provider || profile.model) return "manual";
  return mode ?? "manual";
}

function coordinationConfig(
  config: PaseoAgentConfig,
  profile: NonNullable<Awaited<ReturnType<TeamService["listProjectPacks"]>>["headChefProfile"]>,
) {
  const guidance = [
    config.systemPrompt,
    "You are Kitchen's Head Chef for this native conversation. Coordinate the mission, clarify missing requirements, and keep the user informed. Kitchen owns role assignment, isolated worktrees, review, independent verification, and final human acceptance.",
    "Do not call create_agent or spawn unmanaged subagents. Do not implement, edit, commit, or integrate changes in the source checkout. Request additional work through Kitchen's managed work-request routes. Answer Kitchen's requirements questions through its structured completion report.",
    "Read the actual Kitchen mission state before reporting progress. A completed Head Chef chat turn or a worker's claim is not mission completion. Report pending reviews, permissions, verification, and human acceptance as pending. Describe a finished result only when the actual Kitchen workflow has verified it; distinguish a verified integration candidate from final human acceptance. Never claim approval or bypass the final human gate.",
    profile.instructions,
    ...(profile.steps ?? []).map((step) => step.instructions),
    profile.skills?.length
      ? `Use these installed skills: ${profile.skills.join(", ")}. Report missing skills.`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { ...config, systemPrompt: guidance };
}

async function publishMissionCard(
  boss: PaseoAgentHandle,
  service: TeamService,
  teamId: string,
  presetTitle: string,
) {
  const id = `kitchen-mission:${teamId}`;
  await service.store.commit(teamId, async (draft) => {
    const root = draft.items[draft.team.rootItemId];
    if (root.pack.nativeMissionCardPublished) return { events: [], result: null };
    let page = await boss.timeline.refetch({ direction: "tail", limit: 200 });
    let exists = page.entries.some((entry) => entry.item.type === "plugin" && entry.item.id === id);
    while (!exists && page.hasOlder && page.startCursor) {
      page = await boss.timeline.refetch({
        direction: "before",
        cursor: page.startCursor,
        limit: 200,
      });
      exists = page.entries.some((entry) => entry.item.type === "plugin" && entry.item.id === id);
    }
    if (page.error) throw new Error(page.error);
    if (!exists)
      await boss.timeline.append({
        type: "plugin",
        id,
        kind: KITCHEN_MISSION_KIND,
        version: 1,
        data: { teamId, agentId: boss.id, presetTitle },
      });
    root.pack.nativeMissionCardPublished = true;
    return { events: [], result: null };
  });
}

export async function startNativeMission(
  paseo: PaseoApi,
  service: TeamService,
  input: NativeStart,
) {
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const observed = await workspace.refresh();
  if (
    !observed ||
    observed.archivingAt ||
    (input.projectId && observed.projectId !== input.projectId) ||
    (await realpath(observed.workspaceDirectory)) !== (await realpath(input.cwd))
  )
    throw new Error("Kitchen requires the selected active workspace and project");
  const { project, catalog } = await projectCatalog(service, observed.projectRootPath);
  const preset = catalog.presets.find((value) => value.id === input.presetId);
  if (!preset) throw new Error(catalog.unavailableReason || "Choose an available Kitchen team");
  if (!input.defaultAgentConfig)
    throw new Error("Choose a configured Head Chef provider before starting Kitchen");
  const local = await readProjectProfile(input.cwd);
  const variant = project.workflows.find((value) => value.id === input.presetId);
  const profile = { ...project.headChefProfile, ...local.headChef, ...variant?.headChefProfile };
  const config = headChefConfig(input.defaultAgentConfig, profile);
  const boss = await workspace.agents.create({
    config: coordinationConfig(config, profile),
    idempotencyKey: `${input.idempotencyKey}:head-chef`,
    labels: { "pandaos.routing.mode": nativeRouting(input.routingMode, profile) },
  });
  const split = config.provider.indexOf("/");
  const objective = input.text.trim()
    ? input.text
    : "Deliver the work described in the attached brief. Ask for any missing requirements.";
  const state = await service.startKitchen({
    headChefAgentId: boss.id,
    sourceAgentId: boss.id,
    pendingInitialBrief: true,
    initialBriefHasImages: Boolean(input.images?.length),
    workspaceId: input.workspaceId,
    title: "Kitchen mission",
    objective,
    cwd: input.cwd,
    provider: split < 0 ? config.provider : config.provider.slice(0, split),
    model: split < 0 ? undefined : config.provider.slice(split + 1),
    mode: config.modeId,
    thinking: config.thinkingOptionId,
    packId: variant?.basePackId ?? preset.id,
    workflowId: variant?.id,
    roleProfiles: mergeWorkflowProfiles(
      mergeWorkflowProfiles(project.projectRoles, local.roles),
      variant?.roleProfiles,
    ),
    executionMode: "team",
    workflowMode: "self-organizing",
    missionMode: "goal-driven",
    idempotencyKey: input.idempotencyKey,
    acceptanceCriteria: [{ id: "mission-goal", text: objective }],
    spec: `The complete initial brief and images are in Head Chef ${boss.id}'s native conversation.\n${JSON.stringify({ attachments: input.attachments, images: input.images?.map((image) => ({ mimeType: image.mimeType, sha256: createHash("sha256").update(image.data).digest("hex") })) })}`,
  });
  const messageId = `native:${input.idempotencyKey}`;
  await service.registerNativeInitialMessage(state.team.id, messageId);
  await service.store.commit(state.team.id, (draft) => {
    draft.items[draft.team.rootItemId].pack.nativeProjectRootPath = observed.projectRootPath;
    return { events: [], result: null };
  });
  await boss.send(input.text, { messageId, images: input.images, attachments: input.attachments });
  await service.releaseNativeInitialBrief(state.team.id, messageId);
  await publishMissionCard(boss, service, state.team.id, preset.title);
  return { agentId: boss.id, teamId: state.team.id };
}

export function registerNativeEntry(
  server: PluginServerContext,
  service: (paseo: PaseoApi) => Promise<TeamService>,
) {
  const host = server as NativeHost;
  const supported =
    host.supportsLifecycleEvent?.("agent.user_message_accepted") === true &&
    host.supportsBeforeHookOrigin?.("agent.create") === true;
  server.handle(factoryNativePresets, async (input, { paseo }) => {
    if (!supported)
      return { presets: [], defaultPresetId: "kitchen", unavailableReason: unavailable };
    if (input.projectId) {
      const result = await paseo.projects.list({});
      const selected = result.projects.find((value) => value.projectId === input.projectId);
      if (!selected || (await realpath(selected.projectRootPath)) !== (await realpath(input.cwd)))
        throw new Error("Choose the matching Kitchen project");
    }
    return (await projectCatalog(await service(paseo), input.cwd)).catalog;
  });
  server.handle(factoryNativeStart, async (input, { paseo }) => {
    if (!supported) throw new Error(unavailable);
    return startNativeMission(paseo, await service(paseo), input);
  });
  if (!supported) return () => {};
  const on = server.on as unknown as (
    name: "agent.user_message_accepted",
    handler: (event: AcceptedMessage, context: PluginHookContext) => Promise<void>,
  ) => () => void;
  const removeGuard = server.before("agent.create", async (_input, context) => {
    const origin = (
      context as PluginHookContext & {
        origin?: { kind: "agent" | "plugin" | "client" | "system" | "unknown"; agentId?: string };
      }
    ).origin;
    if (origin?.kind !== "agent") return;
    if (!origin.agentId) throw new Error("Agent creation origin is missing its agent identity");
    await (await service(context.paseo)).assertNativeAgentCreationAllowed(origin.agentId);
  });
  const removeAccepted = on("agent.user_message_accepted", async (event, { paseo, signal }) => {
    if (signal.aborted) return;
    await (
      await service(paseo)
    ).acceptUserMessage({
      agentId: event.agent.id,
      eventId: event.messageId,
      text: event.text,
      context: promptReferences(event.prompt),
      origin: { kind: event.origin },
    });
  });
  return () => {
    removeGuard();
    removeAccepted();
  };
}
