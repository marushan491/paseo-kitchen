import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { PluginServerContext, PluginHookContext } from "@getpaseo/plugin/server";
import type { TeamService } from "./service.js";
import { factoryQuestionActivity, factoryAutonomyStatus } from "../shared/question-contracts.js";

export function providerQuestionText(request: AgentPermissionRequest): string {
  const questions = request.input?.questions;
  const text = Array.isArray(questions)
    ? questions.flatMap((value) => {
        if (typeof value !== "object" || value === null) return [];
        const question = (value as Record<string, unknown>).question;
        return typeof question === "string" ? [question] : [];
      })
    : [];
  return [request.title, request.description, ...text].filter(Boolean).join("\n").slice(0, 16000);
}

export function registerQuestionHooks(
  server: PluginServerContext,
  service: (api: PaseoApi) => Promise<TeamService>,
  inputActivitySupported: boolean,
) {
  server.handle(factoryAutonomyStatus, () => ({ inputActivitySupported }));
  server.handle(factoryQuestionActivity, async (input, { paseo }) => {
    await (await service(paseo)).markQuestionActivity(input.teamId);
    return {};
  });
  const removeRequested = server.on("agent.permission_requested", async (event, { paseo }) => {
    const runtime = await service(paseo);
    if (!(await runtime.isManagedAgent(event.agent.id))) return;
    if (event.request.kind === "tool" && runtime.autonomySettings().autoAcceptPermissions) {
      await paseo.agents
        .ref(event.agent.id)
        .respondToPermission({ requestId: event.request.id, response: { behavior: "allow" } });
    } else if (event.request.kind === "question") {
      await runtime.trackProviderQuestion(event.agent.id, {
        id: event.request.id,
        text: providerQuestionText(event.request),
        responseStartedAt:
          typeof event.request.metadata?.responseStartedAt === "string"
            ? event.request.metadata.responseStartedAt
            : undefined,
      });
    }
  });
  const removeResolved = server.on("agent.permission_resolved", async (event, { paseo }) => {
    await (await service(paseo)).resolveProviderQuestion(event.agent.id, event.requestId);
  });
  const on = server.on as unknown as (
    name: "agent.input_activity",
    handler: (
      event: { agent: { id: string }; requestId?: string; occurredAt: string },
      context: PluginHookContext,
    ) => Promise<void>,
  ) => () => void;
  const removeActivity = inputActivitySupported
    ? on.call(server, "agent.input_activity", async (event, { paseo }) => {
        await (
          await service(paseo)
        ).noteInputActivity(event.agent.id, event.requestId, event.occurredAt);
      })
    : () => {};
  return () => {
    removeRequested();
    removeResolved();
    removeActivity();
  };
}

export async function resumeProviderQuestion(
  paseo: PaseoApi,
  agentId: string,
  requestId: string,
  guidance: string,
): Promise<boolean> {
  const agent = paseo.agents.ref(agentId);
  const snapshot = await agent.refresh();
  const request = snapshot?.agent.pendingPermissions.find((value) => value.id === requestId);
  if (!request || request.kind !== "question" || request.metadata?.responseStartedAt) return false;
  const respond = agent.respondToPermission as unknown as (options: {
    requestId: string;
    expectedNoInputStarted: true;
    response: { behavior: "deny"; message: string; interrupt: false };
  }) => Promise<void>;
  try {
    await respond.call(agent, {
      requestId,
      expectedNoInputStarted: true,
      response: { behavior: "deny", message: guidance, interrupt: false },
    });
    return true;
  } catch (error) {
    if (
      String(error).includes("started answering") ||
      String(error).includes("input_started") ||
      String(error).includes("no longer pending")
    )
      return false;
    throw error;
  }
}

export async function recoverProviderQuestions(paseo: PaseoApi, runtime: TeamService) {
  const agents = new Set<string>();
  for (const id of await runtime.store.listIds()) {
    const state = await runtime.store.get(id);
    if (!state || state.team.status !== "active") continue;
    agents.add(state.team.bossAgentId);
    for (const binding of Object.values(state.bindings))
      if (binding.status === "active" && binding.agentId) agents.add(binding.agentId);
  }
  for (const agentId of agents) {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    for (const request of snapshot?.agent.pendingPermissions ?? []) {
      if (request.kind !== "question") continue;
      await runtime.trackProviderQuestion(agentId, {
        id: request.id,
        text: providerQuestionText(request),
        responseStartedAt:
          typeof request.metadata?.responseStartedAt === "string"
            ? request.metadata.responseStartedAt
            : undefined,
      });
    }
  }
}
