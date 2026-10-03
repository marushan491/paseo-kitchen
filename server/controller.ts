import { readAgentRoutingNotice, type AgentRoutingNotice } from "../shared/agent-routing.js";
import { z } from "zod";
import type { AgentPromptInput } from "@getpaseo/protocol/agent-types";
import type { FactoryCompletionSchema } from "../shared/factory-contracts.js";
import { parseFactoryCompletion } from "./completion.js";
import { realpath } from "node:fs/promises";
import { createHostControl } from "./host-control.js";
import type { HostControlOptions } from "./host-control.js";
import type { PaseoAgentCreateOptions } from "@getpaseo/client";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import { kitchenPermissionConfig } from "./permission-config.js";
export interface FactoryAgent {
  id: string;
  routingNotice?: AgentRoutingNotice;
  title?: string | null;
  workspaceId?: string | null;
  parentAgentId?: string | null;
  usageTotals?: { inputTokens: number; outputTokens: number };
  provider: string;
  cwd: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
  runtimeInfo?: {
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
  };
  model?: string | null;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  updatedAt?: string;
  running?: boolean;
}
export interface FactoryCreate {
  provider: string;
  title: string;
  cwd: string;
  initialPrompt?: string;
  thinking?: string;
  mode?: string;
  autoAcceptPermissions?: boolean;
  labels: Record<string, string>;
  parentAgentId?: string;
  workspaceId?: string;
  decisionId: string;
  worktree?: { worktreeName: string; branchName: string; baseBranch: string };
}
export interface FactorySendContext {
  nativeInitialBrief?: { agentId: string; messageId: string; requireRich?: boolean };
  nativeBrief: { agentId: string; messageId: string; requireRich?: boolean };
}
export interface FactoryController {
  get(id: string): Promise<FactoryAgent | null>;
  completion?(id: string): Promise<z.infer<typeof FactoryCompletionSchema> | null>;
  list(): Promise<FactoryAgent[]>;
  isRunning(id: string): Promise<boolean>;
  create(input: FactoryCreate): Promise<{ id: string }>;
  send(
    id: string,
    text: string,
    behavior?: "steer",
    context?: FactorySendContext,
    messageId?: string,
  ): Promise<void>;
  cancel(id: string): Promise<void>;
  update(id: string, changes: { title?: string; labels?: Record<string, string> }): Promise<void>;
  detach(id: string): Promise<void>;
  moveToWorkspace(id: string, workspaceId: string): Promise<void>;
  resolveWorkspace(
    id: string,
  ): Promise<{ id: string; cwd: string; archivedAt?: string | null } | null>;
  findWorkspaceForCwd(
    cwd: string,
  ): Promise<{ id: string; cwd: string; archivedAt?: string | null } | null>;
  validateProvider(input: { provider: string; model?: string; cwd: string }): Promise<void>;
}
export interface FactoryLogger {
  child(context: Record<string, unknown>): FactoryLogger;
  error(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}
export const factoryLogger: FactoryLogger = {
  child: () => factoryLogger,
  error: (context, message) => console.error(message, context),
  info: (context, message) => console.info(message, context),
  warn: (context, message) => console.warn(message, context),
};
function snapshot(agent: PaseoAgent): FactoryAgent {
  return {
    ...agent,
    routingNotice: readAgentRoutingNotice(agent),
    parentAgentId: agent.labels?.["paseo.parent-agent-id"],
    running: agent.status === "running" || Boolean(agent.activeTurn),
  };
}
export function sdkController(
  paseo: PaseoApi,
  hostOptions: HostControlOptions = {},
): FactoryController {
  const host = createHostControl(paseo, hostOptions);
  const workspace = async (id: string) => {
    const value = await paseo.workspaces.ref(id).refresh();
    return value
      ? {
          id: value.id,
          cwd: value.workspaceDirectory ?? value.projectRootPath,
          archivedAt: value.archivingAt,
        }
      : null;
  };
  return {
    cancel: host.cancel,
    update: host.update,
    moveToWorkspace: host.moveToWorkspace,
    async detach(id) {
      await paseo.agents.ref(id).detach();
    },
    resolveWorkspace: workspace,
    async findWorkspaceForCwd(cwd) {
      let cursor: string | undefined;
      const directory = await realpath(cwd);
      do {
        const result = await paseo.workspaces.list({ page: { limit: 200, cursor } });
        for (const value of result.entries) {
          if (value.archivingAt) continue;
          const path = value.workspaceDirectory ?? value.projectRootPath;
          if ((await realpath(path).catch(() => null)) === directory)
            return { id: value.id, cwd: path, archivedAt: null };
        }
        cursor = result.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return null;
    },
    async validateProvider(input) {
      await host.preflight();
      const separator = input.provider.indexOf("/");
      const provider = separator < 0 ? input.provider : input.provider.slice(0, separator);
      const model =
        input.model ?? (separator < 0 ? undefined : input.provider.slice(separator + 1));
      const result = await paseo.providers.listModels(provider, { cwd: input.cwd });
      if (result.error) throw new Error(result.error);
      if (
        !result.models?.some(
          (entry) => entry.isSelectable !== false && (model ? entry.id === model : entry.isDefault),
        )
      )
        throw new Error(
          `Kitchen provider ${provider} has no selectable ${model ?? "default model"}`,
        );
    },
    async get(id) {
      const result = await paseo.agents.ref(id).refresh();
      return result ? snapshot(result.agent) : null;
    },
    async completion(id) {
      const result = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 200 });
      if (result.error) throw new Error(result.error);
      return parseFactoryCompletion(result.entries.map((entry) => entry.item));
    },
    async list() {
      const agents: FactoryAgent[] = [];
      let cursor: string | undefined;
      do {
        const result = await paseo.agents.list({ page: { limit: 200, cursor } });
        agents.push(...result.entries.map((entry) => snapshot(entry.agent)));
        cursor = result.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return agents;
    },
    async isRunning(id) {
      const result = await paseo.agents.ref(id).refresh();
      return Boolean(result && (result.agent.status === "running" || result.agent.activeTurn));
    },
    async create(input) {
      let provider = input.provider;
      if (!provider.includes("/")) {
        const catalog = await paseo.providers.listModels(provider, { cwd: input.cwd });
        if (catalog.error) throw new Error(catalog.error);
        const model = catalog.models?.find(
          (entry) => entry.isDefault && entry.isSelectable !== false,
        );
        if (!model)
          throw new Error(
            `Select an explicit model for Factory provider ${provider}; no default was advertised`,
          );
        provider = `${provider}/${model.id}`;
      }
      const options: PaseoAgentCreateOptions = {
        idempotencyKey: input.decisionId,
        config: await kitchenPermissionConfig(
          paseo,
          { provider, thinkingOptionId: input.thinking, modeId: input.mode },
          input.cwd,
          input.autoAcceptPermissions === true,
        ),
        cwd: input.cwd,
        parent: input.parentAgentId,
        title: input.title,
        labels: input.labels,
        prompt: input.initialPrompt,
        worktree: input.worktree
          ? {
              mode: "branch-off",
              newBranch: input.worktree.branchName,
              base: input.worktree.baseBranch,
            }
          : undefined,
      };
      let placement = input.workspaceId ? paseo.workspaces.ref(input.workspaceId) : null;
      if (!placement && input.parentAgentId && !input.worktree)
        placement = await paseo.workspaces.open(input.cwd);
      const created = placement
        ? await placement.agents.create(options)
        : await paseo.agents.create(options);
      return { id: created.id };
    },
    async send(id, text, behavior, context, messageId) {
      const blocks = context ? await nativeContext(paseo, context) : [];
      const images = [
        ...new Map(
          blocks
            .filter((block) => block.type === "image")
            .map(({ data, mimeType }) => [`${mimeType}:${data}`, { data, mimeType }]),
        ).values(),
      ];
      const originalText = [
        ...new Set(blocks.filter((block) => block.type === "text").map((block) => block.text)),
      ]
        .filter((value) => !text.includes(value))
        .join("\n");
      const packet = originalText
        ? `${text}\n\n## Native conversation context\n${originalText}`
        : text;
      await paseo.agents.ref(id).send(packet, {
        activeTurnBehavior: behavior,
        ...(messageId ? { messageId } : {}),
        ...(images?.length ? { images } : {}),
      });
    },
  };
}

const NativePromptSchema = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
]);
async function nativeContext(paseo: PaseoApi, context: FactorySendContext) {
  const references = [context.nativeInitialBrief, context.nativeBrief].filter(
    (value): value is FactorySendContext["nativeBrief"] => Boolean(value),
  );
  const unique = [
    ...new Map(references.map((value) => [`${value.agentId}:${value.messageId}`, value])).values(),
  ];
  const prompts = await Promise.all(unique.map((reference) => nativeMessage(paseo, reference)));
  return prompts.flatMap((prompt) =>
    typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : prompt,
  );
}

async function nativeMessage(
  paseo: PaseoApi,
  reference: FactorySendContext["nativeBrief"],
): Promise<AgentPromptInput> {
  let cursor: { epoch: string; seq: number } | undefined;
  do {
    const page = await paseo.agents.ref(reference.agentId).timeline.refetch({
      direction: cursor ? "before" : "tail",
      cursor,
      limit: 200,
      projection: "canonical",
    });
    if (page.error || page.staleCursor || page.gap)
      throw new Error(page.error || "Native brief history is unavailable or incomplete");
    for (const entry of page.entries) {
      const item = entry.item;
      if (
        item.type !== "user_message" ||
        (item.clientMessageId ?? item.messageId) !== reference.messageId
      )
        continue;
      return parseNativePrompt(item, reference.requireRich);
    }
    if (!page.hasOlder || !page.startCursor) break;
    if (cursor?.seq === page.startCursor.seq)
      throw new Error("Native brief history cursor did not advance");
    cursor = page.startCursor;
  } while (cursor);
  throw new Error("The registered native brief was not found in Head Chef's actual conversation");
}

function parseNativePrompt(
  item: { text: string; prompt?: unknown },
  requireRich?: boolean,
): AgentPromptInput {
  const parsed = NativePromptSchema.safeParse(item.prompt);
  if (parsed.success) {
    if (
      requireRich &&
      (typeof parsed.data === "string" || !parsed.data.some((block) => block.type === "image"))
    )
      throw new Error("The host did not preserve the native brief's original images");
    return parsed.data;
  }
  if (requireRich) throw new Error("The host did not preserve the native brief's original images");
  return item.text;
}
