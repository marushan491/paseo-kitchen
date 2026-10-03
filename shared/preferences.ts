import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_AGENT_CAPACITY = 4;
export const AgentCapacitySchema = z.number().int().positive();
export const AutonomySettingsSchema = z.object({
  autoAcceptPermissions: z.boolean().default(true),
  optionalQuestionBehavior: z.enum(["continue", "wait"]).default("continue"),
  questionWaitSeconds: z.number().int().min(5).max(3600).default(60),
});
export type AutonomySettings = z.infer<typeof AutonomySettingsSchema>;

export const factorySettings = defineSettings({
  id: "factory",
  scope: "host",
  version: 1,
  schema: z.object({
    dataDirectory: z.string().default(""),
    daemonHost: z.string().default(""),
    daemonHome: z.string().default(""),
    cliExecutable: z.string().default("paseo"),
    cliArguments: z.array(z.string()).default([]),
    packDirectory: z.string().default(""),
    maxConcurrentAgents: AgentCapacitySchema.default(DEFAULT_AGENT_CAPACITY),
    ...AutonomySettingsSchema.shape,
  }),
});
