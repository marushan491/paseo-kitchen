import { RoleProfileOverrideSchema } from "./role-profile-contracts.js";
export { RoleProfileOverrideSchema, WorkflowStepSchema } from "./role-profile-contracts.js";
import { WorkflowDefinitionSchema } from "./workflow-contracts.js";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ScheduleCadenceSchema } from "@getpaseo/protocol/schedule/types";

export const TEAM_LABEL = "agent-factory.team";
export const TEAM_ROLE_LABEL = "agent-factory.team.role";
export const TEAM_ITEM_LABEL = "agent-factory.team.item";
export const TEAM_DECISION_LABEL = "agent-factory.team.decision";
export const TEAM_TOOLS_LABEL = "agent-factory.team.tools";

// Portions adapted from mastra-ai/mastra mastracode/factory, Apache-2.0. Modified for Agent Factory.

export const ActorSchema = z.object({
  type: z.enum(["human", "boss", "runtime", "role"]),
  id: z.string(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const ArtifactSchema = z.object({
  kind: z.enum(["branch", "commit", "pr", "screenshot", "test-run", "document", "other"]),
  ref: z.string(),
  note: z.string().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const CriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  met: z.boolean().optional(),
  evidence: z.string().optional(),
});

export const RoleProfileSchema = RoleProfileOverrideSchema.extend({ provider: z.string().min(1) });
export type RoleProfile = z.infer<typeof RoleProfileSchema>;
export type RoleProfileOverride = z.infer<typeof RoleProfileOverrideSchema>;
export const FactoryPolicySchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().finite().positive().optional(),
  maxAgentStarts: z.number().int().positive().optional(),
  maxChainSteps: z.number().int().positive().optional(),
  requireOutcomeJudge: z.boolean().optional(),
  maxDelegationDepth: z.number().int().nonnegative().optional(),
  maxDelegatedItems: z.number().int().nonnegative().optional(),
  roleActiveMs: z.number().int().positive().optional(),
  totalActiveMs: z.number().int().positive().optional(),
});
export type FactoryPolicy = z.infer<typeof FactoryPolicySchema>;
export const PublicationSchema = z.object({
  enabled: z.boolean(),
  remote: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  title: z.string().min(1).optional(),
});
export const EvidenceResultSchema = z.object({
  id: z.string().min(1),
  criterionId: z.string().min(1).optional(),
  kind: z.enum(["command", "browser-artifact", "protected-files", "judge"]),
  passed: z.boolean(),
  summary: z.string(),
  checkedAt: z.string(),
  candidateCommit: z.string().optional(),
  artifactSha256: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;
export const WorkflowProfileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  targetRole: z.string().min(1).optional(),
  brief: z
    .object({
      task: z.string().min(1),
      responsibility: z.string().min(1),
      outcome: z.string().min(1),
    })
    .optional(),
  profile: RoleProfileOverrideSchema.omit({ workflowProfileId: true }),
});
export type WorkflowProfile = z.infer<typeof WorkflowProfileSchema>;

export const WorkItemSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  packId: z.string(),
  packVersion: z.number().int(),
  board: z.string(),
  parentId: z.string().optional(),
  title: z.string(),
  objective: z.string(),
  phase: z.string(),
  phaseHistory: z.array(
    z.object({
      phase: z.string(),
      enteredAt: z.string(),
      exitedAt: z.string().optional(),
      by: ActorSchema,
    }),
  ),
  revision: z.number().int(),
  dependsOn: z.array(z.object({ id: z.string(), until: z.string() })),
  conflictsWith: z.array(z.string()),
  exclusive: z.boolean().optional(),
  acceptanceCriteria: z.array(CriterionSchema),
  artifacts: z.array(ArtifactSchema),
  reports: z.array(
    z.object({ role: z.string(), phase: z.string(), outcome: z.string(), summary: z.string() }),
  ),
  returns: z.number().int(),
  bindings: z.record(z.string(), z.string()),
  roleProfiles: z.record(z.string(), RoleProfileSchema).optional(),
  checks: z.array(EvidenceResultSchema).optional(),
  pack: z.record(z.string(), z.unknown()),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const BindingSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  role: z.string(),
  phase: z.string(),
  revisionAtStart: z.number().int(),
  decisionId: z.string(),
  agentId: z.string(),
  profile: z.string(),
  executedProfile: RoleProfileSchema.optional(),
  status: z.enum(["active", "revoked"]),
  turn: z.enum(["starting", "running", "idle", "reported"]),
  nudges: z.number().int(),
  errors: z.number().int().default(0),
  lastEventAt: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
  activeStartedAt: z.string().optional(),
  activeMs: z.number().nonnegative().optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const DecisionKindSchema = z.enum([
  "start-role",
  "message-role",
  "notify-human",
  "invoke-pack-action",
]);

export const DecisionSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  workItemId: z.string(),
  kind: DecisionKindSchema,
  payload: z.record(z.string(), z.unknown()),
  phase: z.string(),
  status: z.enum(["pending", "leased", "succeeded", "retry", "failed", "superseded", "proposed"]),
  attempts: z.number().int(),
  availableAt: z.string(),
  leaseExpiresAt: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const TeamRuntimeSchema = z.object({
  limits: z.object({
    maxActiveCooks: z.number().int().positive(),
    roleActiveMs: z.number().positive().optional(),
    totalActiveMs: z.number().positive().optional(),
    observedTokens: z.number().int().positive().optional(),
  }),
  usage: z.object({
    activeMs: z.number().nonnegative(),
    roleActiveMs: z.record(z.string(), z.number().nonnegative()),
    observedTokens: z.number().nonnegative().optional(),
    tokensAvailable: z.boolean(),
  }),
  limitReason: z.string().optional(),
});

export const TeamSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  cwd: z.string(),
  baseBranch: z.string().optional(),
  bossAgentId: z.string(),
  packId: z.string(),
  packVersion: z.number().int(),
  rootItemId: z.string(),
  status: z.enum(["active", "paused", "done", "canceled"]),
  pausedReason: z.string().optional(),
  roleProfiles: z.record(z.string(), RoleProfileSchema),
  policy: FactoryPolicySchema.optional(),
  importedFrom: z
    .object({ source: z.string(), importedAt: z.string(), readOnly: z.boolean() })
    .optional(),
  workflowSnapshot: WorkflowDefinitionSchema.optional(),
  runtime: TeamRuntimeSchema.optional(),
  kitchen: z
    .object({
      idempotencyKey: z.string(),
      requestFingerprint: z.string(),
      mode: z.literal("accompanied"),
      workflowMode: z.enum(["fixed", "self-organizing"]).optional(),
      missionMode: z.enum(["goal-driven", "planned"]).optional(),
      executionMode: z.enum(["single", "team"]).optional(),
      classification: z
        .object({
          source: z.literal("jev"),
          model: z.string().min(1),
          executionMode: z.enum(["single", "team", "human"]),
          confidence: z.number().min(0).max(1),
          latencyMs: z.number().nonnegative(),
          reason: z.string(),
          usage: z
            .object({
              inputTokens: z.number().int().nonnegative(),
              outputTokens: z.number().int().nonnegative(),
            })
            .optional(),
        })
        .optional(),
      spec: z.string().optional(),
      publication: PublicationSchema.optional(),
      published: z.object({ commit: z.string(), url: z.string(), at: z.string() }).optional(),
      approval: z
        .object({
          method: z.literal("plugin-credential"),
          credentialId: z.string(),
          candidateCommit: z.string(),
          at: z.string(),
        })
        .optional(),
      stopped: z.boolean().optional(),
      scheduleId: z.string().optional(),
      kind: z.enum(["feature", "bug", "maintenance"]).optional(),
      nativeConversation: z.boolean().optional(),
      sourceAgentId: z.string().optional(),
      acceptedAt: z.string().optional(),
      acceptedBy: z.string().optional(),
      acceptedCommit: z.string().optional(),
      requests: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  createdAt: z.string(),
});
export type Team = z.infer<typeof TeamSchema>;

export const TeamStateSchema = z.object({
  eventCount: z.number().int().nonnegative().optional(),
  commit: z.number().int(),
  team: TeamSchema,
  items: z.record(z.string(), WorkItemSchema),
  bindings: z.record(z.string(), BindingSchema),
  decisions: z.record(z.string(), DecisionSchema),
});
export type TeamState = z.infer<typeof TeamStateSchema>;

export const TeamEventSchema = z.object({
  id: z.string(),
  commit: z.number().int(),
  at: z.string(),
  type: z.string(),
  actor: ActorSchema,
  workItemId: z.string().optional(),
  text: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TeamEvent = z.infer<typeof TeamEventSchema>;

export const TeamReportPayloadSchema = z.object({
  outcome: z.string().min(1),
  summary: z.string().min(1),
  artifacts: z.array(ArtifactSchema).optional(),
  criteria: z
    .array(z.object({ id: z.string(), met: z.boolean(), evidence: z.string() }))
    .optional(),
  needs: z
    .object({
      kind: z.enum(["human", "head-chef", "research", "split"]),
      category: z
        .enum(["clarification", "architecture", "requirements", "irreversible"])
        .optional(),
      text: z.string(),
    })
    .optional()
    .describe(
      "Only when you could not finish your part and someone must decide or add something. Leave it out when your part is done.",
    ),
});
export type TeamReportPayload = z.infer<typeof TeamReportPayloadSchema>;

export const PlannedItemSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).optional(),
  conflictsWith: z.array(z.string()).optional(),
  exclusive: z.boolean().optional(),
});
export type PlannedItem = z.infer<typeof PlannedItemSchema>;

const TeamIdSchema = z.string().regex(/^team_[A-Za-z0-9_-]+$/);
export const factoryList = defineRpc({
  name: "factory.list",
  input: z.object({ bossAgentId: z.string().optional() }),
  output: z.object({ teams: z.array(TeamStateSchema) }),
});
export const FactoryWorkflowSchema = z.object({
  maxParallel: z.number().int().positive(),
  boards: z.record(
    z.string(),
    z.object({
      initialPhase: z.string(),
      phases: z.record(
        z.string(),
        z.object({
          title: z.string(),
          kind: z.enum(["resting", "working", "terminal"]),
          role: z.string().optional(),
          outcomes: z.record(z.string(), z.string()).optional(),
          next: z.string().optional(),
          completeWithChildren: z.string().optional(),
        }),
      ),
    }),
  ),
  roles: z.record(
    z.string(),
    z.object({
      title: z.string(),
      instructions: z.string().optional(),
      skills: z.array(z.string()).optional(),
      canEdit: z.boolean().optional(),
      workspace: z.string().optional(),
    }),
  ),
});
export const factoryStatus = defineRpc({
  name: "factory.status",
  input: z.object({ teamId: TeamIdSchema }),
  output: z.object({
    state: TeamStateSchema,
    events: z.array(TeamEventSchema),
    workflow: FactoryWorkflowSchema.optional(),
  }),
});
export const factoryStart = defineRpc({
  name: "factory.start",
  input: z.object({
    bossAgentId: z.string().min(1),
    title: z.string().min(1),
    objective: z.string().min(1),
    cwd: z.string().min(1).optional(),
    packId: z.string().min(1).optional(),
    force: z.boolean().optional(),
    roleProfiles: z.record(z.string(), RoleProfileOverrideSchema).optional(),
  }),
  output: TeamStateSchema,
});
export const factoryMessage = defineRpc({
  name: "factory.message",
  input: z.object({ teamId: TeamIdSchema, text: z.string().min(1), actorId: z.string().min(1) }),
  output: z.object({}),
});
export const factorySetStatus = defineRpc({
  name: "factory.set-status",
  input: z.object({
    teamId: TeamIdSchema,
    status: z.enum(["active", "paused", "canceled"]),
    actorId: z.string().min(1),
  }),
  output: z.object({}),
});
export const factoryRetry = defineRpc({
  name: "factory.retry",
  input: z.object({
    teamId: TeamIdSchema,
    decisionId: z.string().min(1),
    actorId: z.string().min(1),
  }),
  output: z.object({}),
});
export const factoryReport = defineRpc({
  name: "factory.report",
  input: z.object({ agentId: z.string().min(1), report: TeamReportPayloadSchema }),
  output: z.object({ message: z.string() }),
});
export const factoryPlan = defineRpc({
  name: "factory.plan",
  input: z.object({ agentId: z.string().min(1), items: z.array(PlannedItemSchema).min(1) }),
  output: z.object({ message: z.string() }),
});
export const WorkRequestSchema = z.object({
  requestId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  parentId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  conflictsWith: z.array(z.string()).optional(),
});
export type WorkRequestInput = z.infer<typeof WorkRequestSchema>;
export const StartKitchenSchema = z.object({
  headChefAgentId: z.string().optional(),
  workflowId: z.string().optional(),
  title: z.string().min(1),
  objective: z.string().min(1),
  cwd: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().optional(),
  mode: z.string().optional(),
  thinking: z.string().optional(),
  packId: z.string().optional(),
  idempotencyKey: z.string().min(1),
  roleProfiles: z.record(z.string(), RoleProfileOverrideSchema).optional(),
  workflowMode: z.enum(["fixed", "self-organizing"]).optional(),
  missionMode: z.enum(["goal-driven", "planned"]).optional(),
  executionMode: z.enum(["auto", "single", "team"]).optional(),
  spec: z.string().optional(),
  publication: PublicationSchema.optional(),
  policy: FactoryPolicySchema.optional(),
  scheduleId: z.string().optional(),
  kind: z.enum(["feature", "bug", "maintenance"]).optional(),
  sourceAgentId: z.string().optional(),
  workspaceId: z.string().optional(),
  acceptanceCriteria: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(1),
});
export type StartKitchenInput = z.infer<typeof StartKitchenSchema>;
export const factoryKitchenStart = defineRpc({
  name: "factory.kitchen.start",
  input: StartKitchenSchema,
  output: TeamStateSchema,
});
export const factoryKitchenControl = defineRpc({
  name: "factory.kitchen.control",
  input: z.object({
    teamId: TeamIdSchema,
    action: z.enum(["pause", "resume", "stop", "cancel", "accept"]),
    actorId: z.string().min(1),
    credential: z.string().min(1).max(4096).optional(),
    candidateCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
  }),
  output: TeamStateSchema,
});
export const factoryPublish = defineRpc({
  name: "factory.publish",
  input: z.object({
    teamId: TeamIdSchema,
    credential: z.string().min(1).max(4096),
    candidateCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  }),
  output: TeamStateSchema,
});
export const FactoryPackSchema = z.object({
  roles: z.record(z.string(), z.object({ id: z.string(), title: z.string() })).optional(),
  id: z.string(),
  title: z.string(),
  version: z.number().int(),
  requireVerification: z.boolean().optional(),
  maxDelegationDepth: z.number().optional(),
  maxDelegatedItems: z.number().optional(),
  workflow: FactoryWorkflowSchema,
});
export const factoryPacks = defineRpc({
  name: "factory.packs",
  input: z.object({}),
  output: z.object({ packs: z.array(FactoryPackSchema) }),
});
export const factoryRequestWork = defineRpc({
  name: "factory.work.request",
  input: z.object({ agentId: z.string().min(1), request: WorkRequestSchema }),
  output: z.object({ message: z.string() }),
});
export const FactoryCompletionSchema = z.object({
  report: TeamReportPayloadSchema,
  items: z.array(PlannedItemSchema).min(1).optional(),
  workRequests: z.array(WorkRequestSchema).min(1).optional(),
});

export const KitchenScheduleTargetSchema = StartKitchenSchema.omit({
  idempotencyKey: true,
  scheduleId: true,
});
export const KitchenScheduleRunSchema = z.object({
  slot: z.string(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "retry", "succeeded", "failed"]),
  attempts: z.number().int().nonnegative(),
  retryAt: z.string().nullable(),
  teamId: z.string().nullable(),
  error: z.string().nullable(),
  target: KitchenScheduleTargetSchema,
});
export const KitchenScheduleSchema = z.object({
  id: z.string().regex(/^schedule_[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  cadence: ScheduleCadenceSchema,
  target: KitchenScheduleTargetSchema,
  status: z.enum(["active", "paused", "completed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  expiresAt: z.string().nullable(),
  runs: z.array(KitchenScheduleRunSchema),
});
export type KitchenSchedule = z.infer<typeof KitchenScheduleSchema>;
export const KitchenScheduleSaveSchema = z.object({
  id: KitchenScheduleSchema.shape.id.optional(),
  name: z.string().min(1),
  cadence: ScheduleCadenceSchema,
  target: KitchenScheduleTargetSchema,
  maxRuns: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  actorId: z.string().min(1),
});
export const factoryScheduleList = defineRpc({
  name: "factory.schedule.list",
  input: z.object({}),
  output: z.object({ schedules: z.array(KitchenScheduleSchema) }),
});
export const factoryScheduleSave = defineRpc({
  name: "factory.schedule.save",
  input: KitchenScheduleSaveSchema,
  output: KitchenScheduleSchema,
});
export const factoryScheduleControl = defineRpc({
  name: "factory.schedule.control",
  input: z.object({
    id: KitchenScheduleSchema.shape.id,
    action: z.enum(["pause", "resume", "run-once", "delete"]),
    actorId: z.string().min(1),
  }),
  output: KitchenScheduleSchema.nullable(),
});

export const factoryProfilesList = defineRpc({
  name: "factory.profiles.list",
  input: z.object({}),
  output: z.object({ profiles: z.array(WorkflowProfileSchema) }),
});
export const factoryProfilesSave = defineRpc({
  name: "factory.profiles.save",
  input: z.object({
    profile: WorkflowProfileSchema,
    cwd: z.string().min(1),
    actorId: z.string().min(1),
  }),
  output: WorkflowProfileSchema,
});
export const factoryProfilesRemove = defineRpc({
  name: "factory.profiles.remove",
  input: z.object({ id: WorkflowProfileSchema.shape.id, actorId: z.string().min(1) }),
  output: z.object({}),
});
export const factoryWorkConfigure = defineRpc({
  name: "factory.work.configure",
  input: z.object({
    teamId: TeamIdSchema,
    workItemId: z.string().min(1),
    role: z.string().min(1),
    profile: RoleProfileOverrideSchema,
    actorId: z.string().min(1),
  }),
  output: TeamStateSchema,
});
