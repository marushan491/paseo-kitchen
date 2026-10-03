import { RoleProfileOverrideSchema } from "./role-profile-contracts.js";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WorkflowIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const FileConditionSchema = z.object({
  kind: z.literal("changed-files"),
  any: z
    .array(
      z.object({
        prefix: z.string().min(1).max(160).optional(),
        suffix: z.string().min(1).max(80).optional(),
      }),
    )
    .min(1)
    .max(24),
});
export const WorkflowPhaseSchema = z.object({
  title: z.string().min(1).max(160),
  kind: z.enum(["resting", "working", "terminal"]),
  role: WorkflowIdSchema.optional(),
  outcomes: z.record(WorkflowIdSchema, WorkflowIdSchema).optional(),
  next: WorkflowIdSchema.optional(),
  completeWithChildren: WorkflowIdSchema.optional(),
  condition: FileConditionSchema.optional(),
  skipTo: WorkflowIdSchema.optional(),
  maxReturns: z.number().int().nonnegative().optional(),
});
export const WorkflowRoleSchema = z.object({
  id: WorkflowIdSchema,
  title: z.string().min(1).max(160),
  instructions: z.string().max(16000),
  skills: z.array(z.string().min(1).max(160)).max(32),
  canEdit: z.boolean(),
  workspace: z.enum(["team", "own-worktree", "item-worktree"]),
  tools: z.array(z.enum(["item_plan", "item_request_work"])).max(2),
  evidence: z.boolean().optional(),
  communication: z
    .object({
      clarification: z.enum(["human", "head-chef"]),
      investigation: z.enum(["human", "request-work"]),
    })
    .optional(),
});
export const WorkflowDefinitionSchema = z.object({
  id: WorkflowIdSchema,
  revision: z.number().int().nonnegative(),
  basePackId: WorkflowIdSchema,
  basePackVersion: z.number().int().positive(),
  title: z.string().min(1).max(160),
  roleProfiles: z.record(WorkflowIdSchema, RoleProfileOverrideSchema).optional(),
  headChefProfile: RoleProfileOverrideSchema.optional(),
  runtimePolicy: z
    .object({
      maxReturns: z.number().int().nonnegative(),
      maxDelegationDepth: z.number().int().nonnegative().optional(),
      maxDelegatedItems: z.number().int().nonnegative().optional(),
      dependencyPhase: WorkflowIdSchema.optional(),
    })
    .optional(),
  roles: z.record(WorkflowIdSchema, WorkflowRoleSchema),
  boards: z.record(
    WorkflowIdSchema,
    z.object({
      initialPhase: WorkflowIdSchema,
      phases: z.record(WorkflowIdSchema, WorkflowPhaseSchema),
    }),
  ),
  autonomy: z
    .object({
      architecture: z.enum(["human", "head-chef"]),
      requirements: z.literal("human"),
      irreversibleActions: z.literal("human"),
      finalAcceptance: z.literal("human"),
    })
    .optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type FileCondition = z.infer<typeof FileConditionSchema>;
export const WorkflowPreviewSchema = z.object({
  previewId: z.string(),
  definition: WorkflowDefinitionSchema,
  expectedRevision: z.number().int().nonnegative(),
  summary: z.array(z.string()),
  source: z.literal("jev"),
  confidence: z.number().min(0).max(1),
  model: z.string(),
  requiresConfirmation: z.literal(true),
});
export type WorkflowPreview = z.infer<typeof WorkflowPreviewSchema>;
export const factoryWorkflowsList = defineRpc({
  name: "factory.workflows.list",
  input: z.object({}),
  output: z.object({
    workflows: z.array(WorkflowDefinitionSchema),
    templates: z.array(WorkflowDefinitionSchema),
  }),
});
export const factoryWorkflowSave = defineRpc({
  name: "factory.workflow.save",
  input: z.object({
    definition: WorkflowDefinitionSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  output: WorkflowDefinitionSchema,
});
export const factoryWorkflowValidate = defineRpc({
  name: "factory.workflow.validate",
  input: z.object({ definition: WorkflowDefinitionSchema }),
  output: WorkflowDefinitionSchema,
});
export const factoryWorkflowPreview = defineRpc({
  name: "factory.workflow.preview",
  input: z.object({
    id: WorkflowIdSchema,
    basePackId: WorkflowIdSchema,
    cwd: z.string().min(1),
    request: z.string().min(1).max(8000),
    expectedRevision: z.number().int().nonnegative(),
    role: WorkflowIdSchema.optional(),
  }),
  output: WorkflowPreviewSchema,
});
export const factoryWorkflowApply = defineRpc({
  name: "factory.workflow.apply",
  input: z.object({ previewId: z.string(), expectedRevision: z.number().int().nonnegative() }),
  output: WorkflowDefinitionSchema,
});
