import { defineRpc } from "@getpaseo/plugin";
import {
  CreateAgentRequestMessageSchema,
  AgentAttachmentSchema,
  SendAgentMessageSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

export const KITCHEN_EXECUTION_ID = "agent-factory:kitchen";
export const KITCHEN_MISSION_KIND = "kitchen-mission";
export const NativeAgentConfigSchema = CreateAgentRequestMessageSchema.shape.config
  .omit({ cwd: true, title: true, model: true, providerOptions: true })
  .extend({ options: CreateAgentRequestMessageSchema.shape.config.shape.providerOptions });
export const TeamPresetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  group: z.enum(["Standard", "Project teams"]),
});
export const NativePresetsSchema = z.object({
  presets: z.array(TeamPresetSchema),
  defaultPresetId: z.string(),
  unavailableReason: z.string().optional(),
});
export const NativeStartSchema = z
  .object({
    workspaceId: z.string().min(1),
    cwd: z.string().min(1),
    projectId: z.string().optional(),
    presetId: z.string().min(1),
    text: z.string(),
    images: SendAgentMessageSchema.shape.images,
    attachments: z.array(AgentAttachmentSchema).optional(),
    idempotencyKey: z.string().min(1),
    defaultAgentConfig: NativeAgentConfigSchema.optional(),
    routingMode: z.enum(["auto", "manual"]).optional(),
  })
  .refine(
    (input) => Boolean(input.text.trim() || input.images?.length || input.attachments?.length),
    {
      message: "Describe the mission or attach its brief",
    },
  );
export type NativeStart = z.infer<typeof NativeStartSchema>;
export type TeamPreset = z.infer<typeof TeamPresetSchema>;
export type NativePresets = z.infer<typeof NativePresetsSchema>;
export const factoryNativePresets = defineRpc({
  name: "factory.native.presets",
  input: z.object({ cwd: z.string().min(1), projectId: z.string().optional() }),
  output: NativePresetsSchema,
});
export const factoryNativeStart = defineRpc({
  name: "factory.native.start",
  input: NativeStartSchema,
  output: z.object({ agentId: z.string(), teamId: z.string() }),
});
export const NativeMissionSchema = z.object({
  teamId: z.string().min(1),
  agentId: z.string().min(1),
  presetTitle: z.string().min(1),
});
export type NativeMission = z.infer<typeof NativeMissionSchema>;
