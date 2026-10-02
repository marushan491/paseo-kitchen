import { workflowHead, observeChangedFiles } from "./workflow-runtime.js";
import {
  WorkflowDefinitions,
  definitionFromPack,
  packFromSnapshot,
} from "./workflow-definitions.js";
import type { WorkflowDefinition } from "../shared/workflow-contracts.js";
import { resolveAgentCapacity } from "./capacity-policy.js";
import type { KitchenDecisionSource } from "./system-one.js";
import {
  captureTrackedFiles,
  assertCriterionEvidence,
  assertProtectedUnchanged,
  runIndependentChecks,
  type IndependentCheckOptions,
  type ProtectedSnapshot,
} from "./evidence.js";
import type { EvidenceResult } from "../shared/factory-contracts.js";
import { publishCandidate, type PublicationCli, type PublicationRunner } from "./publication.js";
import {
  assertPolicyAllows,
  assertOutcomeJudged,
  evaluatePolicy,
  type PolicyObservation,
} from "./policy.js";
import { verifyOperatorApproval } from "./approval.js";
import { WorkflowProfiles } from "./profiles.js";
import {
  RoleProfileOverrideSchema,
  type RoleProfileOverride,
  type WorkflowProfile,
} from "../shared/factory-contracts.js";
import type { FactoryAgent, FactoryController, FactoryLogger } from "./controller.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  RUNTIME,
  ReportRejectedError,
  activeBinding,
  addDecision,
  applyReport,
  blockForBoss,
  boardOf,
  createTeamState,
  enterPhase,
  isWorking,
  isTerminal,
  summarizeTeam,
  newId,
  planItems,
  requestWork as expandWork,
  type WorkRequestInput,
  schedule,
} from "./engine.js";
import { type PackRegistry, type Role, type WorkflowPack } from "./pack.js";
import { type TeamEventDraft, TeamStore } from "./store.js";
import {
  TEAM_DECISION_LABEL,
  TEAM_ITEM_LABEL,
  TEAM_LABEL,
  TEAM_ROLE_LABEL,
  TEAM_TOOLS_LABEL,
  type Actor,
  type Binding,
  type Decision,
  type PlannedItem,
  type Team,
  type StartKitchenInput,
  type TeamReportPayload,
  type TeamState,
  type WorkItem,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DISPATCH_INTERVAL_MS = 2_000;
const HEALTH_INTERVAL_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const NO_PROGRESS_MS = 45 * 60_000;
const MAX_ERROR_RETRIES = 4;
const KITCHEN_REQUEST_LABEL = "agent-factory.kitchen.request";

export type { StartKitchenInput } from "./types.js";

interface PreparedKitchen {
  cwd: string;
  pack: WorkflowPack;
  criteria: StartKitchenInput["acceptanceCriteria"];
  workspaceId?: string;
}

interface KitchenClaim {
  requestId: string;
  claim: string;
}

export interface TeamServiceOptions {
  storageRoot: string;
  logger: FactoryLogger;
  controller: FactoryController;
  packs: PackRegistry;
  now?: () => Date;
  timers?: boolean;
  maxConcurrentAgents?: () => number;
  roleProfiles?: () => Team["roleProfiles"];
  operatorCredential?: () => string | undefined | Promise<string | undefined>;
  publicationCli?: PublicationCli;
  publicationRunner?: PublicationRunner;
  decisionSource?: KitchenDecisionSource;
  independentChecks?: IndependentCheckOptions;
  verificationSnapshot?: (cwd: string) => Promise<ProtectedSnapshot>;
  policyUsage?: (state: TeamState) => Promise<PolicyObservation["usage"]>;
}

export class TeamNotNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamNotNeededError";
  }
}

export interface TeamCallerBinding {
  teamId: string;
  binding: Binding;
}

export class TeamService {
  readonly store: TeamStore;
  readonly profiles: WorkflowProfiles;
  private readonly logger: FactoryLogger;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private dispatchRun: Promise<void> | null = null;
  private dispatchAgain = false;
  private readonly now: () => Date;
  readonly workflows: WorkflowDefinitions;
  private readonly kitchenStarts = new Map<string, Promise<TeamState>>();
  private kitchenStartChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TeamServiceOptions) {
    this.profiles = new WorkflowProfiles(options.storageRoot);
    this.workflows = new WorkflowDefinitions(options.storageRoot, options.packs);
    this.store = new TeamStore(join(options.storageRoot, "teams"));
    this.logger = options.logger.child({ module: "team" });
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    this.capacity();
    this.stopped = false;
    for (const teamId of await this.store.listIds()) {
      try {
        await this.recoverTeam(teamId);
      } catch (error) {
        this.logger.error({ err: error, teamId }, "Team recovery failed");
        await this.store.commit(teamId, (draft) => {
          if (draft.team.status === "done" || draft.team.status === "canceled")
            return { events: [], result: null };
          draft.team.status = "paused";
          draft.team.pausedReason = "Recovery failed; inspect the agent history before resuming";
          return {
            events: [{ type: "team.paused", actor: RUNTIME, text: draft.team.pausedReason }],
            result: null,
          };
        });
      }
    }
    if (this.options.timers === false) return;
    this.dispatchTimer = setInterval(() => void this.dispatchAll(), DISPATCH_INTERVAL_MS);
    this.healthTimer = setInterval(
      () =>
        void this.healthAll().catch((error) =>
          this.logger.error({ err: error }, "Factory health failed"),
        ),
      HEALTH_INTERVAL_MS,
    );
    void this.dispatchAll();
  }

  stop(): void {
    this.stopped = true;
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.dispatchRun;
  }
  private capacity(): number {
    return resolveAgentCapacity(this.options.maxConcurrentAgents?.());
  }

  private limitPack(pack: WorkflowPack): WorkflowPack {
    return { ...pack, maxParallel: this.capacity() };
  }
  private pack(team: Team): WorkflowPack {
    if (team.workflowSnapshot) return this.limitPack(packFromSnapshot(team.workflowSnapshot));
    const pack = this.options.packs.get(team.packId);
    if (!pack) throw new Error(`Workflow pack ${team.packId} is not installed`);
    return this.limitPack(pack);
  }

  private policyPack(team: Team): WorkflowPack {
    const pack = this.pack(team);
    return {
      ...pack,
      maxDelegationDepth: selectedLimit(pack.maxDelegationDepth, team.policy?.maxDelegationDepth),
      maxDelegatedItems: selectedLimit(pack.maxDelegatedItems, team.policy?.maxDelegatedItems),
    };
  }

  private async recoverTeam(teamId: string): Promise<void> {
    const state = await this.store.get(teamId);
    if (!state) return;
    if (
      state.team.importedFrom?.readOnly ||
      state.team.status === "done" ||
      state.team.status === "canceled"
    )
      return;
    await this.syncKitchenBoss(state.team);
    const pack = state.team.workflowSnapshot
      ? packFromSnapshot(state.team.workflowSnapshot)
      : this.options.packs.get(state.team.packId);
    if (!pack || pack.version !== state.team.packVersion) {
      const canMigrate = pack?.migrate && state.team.packVersion < pack.version;
      if (!canMigrate) {
        await this.store.commit(teamId, (draft) => {
          draft.team.status = "paused";
          draft.team.pausedReason = `pack-version-mismatch: team uses ${state.team.packId}@${state.team.packVersion}, installed ${pack ? pack.version : "none"}`;
          return {
            events: [{ type: "team.paused", actor: RUNTIME, text: draft.team.pausedReason }],
            result: null,
          };
        });
        return;
      }
      await this.store.commit(teamId, (draft) => {
        const from = draft.team.packVersion;
        for (const [id, item] of Object.entries(draft.items)) {
          draft.items[id] = { ...pack.migrate!(item.packVersion, item), packVersion: pack.version };
        }
        draft.team.packVersion = pack.version;
        return {
          events: [
            {
              type: "team.migrated",
              actor: RUNTIME,
              text: `Pack ${pack.id} migrated ${from} → ${pack.version}`,
            },
          ],
          result: null,
        };
      });
    }

    await this.store.commit(teamId, async (draft) => {
      const events: TeamEventDraft[] = [];
      const legacyReason = clearLegacyRuntimeLimit(draft.team);
      const runtime = (draft.team.runtime ??= runtimeState(draft.team.policy, this.capacity()));
      runtime.limits.maxActiveCooks = this.capacity();
      if (legacyReason)
        events.push({ type: "safety.limit-migrated", actor: RUNTIME, text: legacyReason });
      for (const decision of Object.values(draft.decisions)) {
        if (decision.status === "leased") {
          decision.status = "retry";
          decision.leaseExpiresAt = undefined;
        }
      }
      for (const binding of Object.values(draft.bindings))
        await this.recoverBinding(draft, binding, events);
      events.push(...this.recoverCompletion(draft));
      return { events, result: null };
    });
  }

  private async recoverBinding(
    draft: TeamState,
    binding: Binding,
    events: TeamEventDraft[],
  ): Promise<void> {
    if (binding.status !== "active" || binding.turn === "reported") return;
    if (binding.turn !== "running") chargeBinding(draft, binding, this.now().getTime());
    if (!binding.agentId) {
      const found = await this.findAgentForDecision(binding.decisionId);
      if (!found) {
        chargeBinding(draft, binding, this.now().getTime());
        return;
      }
      binding.agentId = found;
      binding.turn = "running";
    }

    if (binding.turn !== "running") return;
    const record = await this.options.controller.get(binding.agentId);
    if (record?.running) return;
    const settledAt = record?.updatedAt
      ? Math.min(this.now().getTime(), Date.parse(record.updatedAt))
      : this.now().getTime();
    chargeBinding(
      draft,
      binding,
      Math.max(Date.parse(binding.activeStartedAt ?? this.now().toISOString()), settledAt),
    );
    const item = draft.items[binding.workItemId];
    if (!record || record.archivedAt || !item) {
      binding.status = "revoked";
      binding.revokedAt = this.now().toISOString();
      if (item && isWorking(this.pack(draft.team), item)) {
        addDecision(
          draft,
          item,
          "start-role",
          { role: binding.role, revision: item.revision },
          `restart:${item.id}:${item.revision}:${binding.id}`,
        );
      }
      events.push({
        type: "recovery.reseat",
        actor: RUNTIME,
        workItemId: binding.workItemId,
        text: `${binding.role} session is gone; starting a new one`,
      });
      return;
    }

    if (await this.recoverReport(draft, binding, item, events)) return;
    if (item) {
      binding.turn = "starting";
      addDecision(
        draft,
        item,
        "message-role",
        { bindingId: binding.id, resume: true },
        `resume:${binding.id}:${draft.commit}`,
      );
      events.push({
        type: "recovery.resume",
        actor: RUNTIME,
        workItemId: item.id,
        text: `Daemon restarted; resuming the ${binding.role} session for ${item.title}`,
      });
    }
  }

  private async recoverReport(
    draft: TeamState,
    binding: Binding,
    item: WorkItem,
    events: TeamEventDraft[],
  ): Promise<boolean> {
    const completion = await this.options.controller.completion?.(binding.agentId);
    if (completion) {
      const checks = await this.verifyReportCheckout(
        binding.agentId,
        draft,
        this.pack(draft.team).roles[binding.role],
        completion.report,
      );
      if (checks.length) {
        item.checks = checks;
        events.push({
          type: "evidence.checked",
          actor: RUNTIME,
          workItemId: item.id,
          text: "Recovered independent verification",
          data: { checks },
        });
        if (checks.some((check) => !check.passed)) {
          draft.team.status = "paused";
          draft.team.pausedReason =
            "Recovered verifier failed independent evidence or protected-file verification";
          binding.turn = "idle";
          return true;
        }
      }
      if (
        completion.items &&
        !Object.values(draft.items).some((child) => child.parentId === item.id)
      )
        planItems(draft, this.pack(draft.team), binding, completion.items, events);
      if (completion.workRequests?.length) {
        if (draft.team.kitchen?.workflowMode !== "self-organizing")
          throw new ReportRejectedError("Work requests require a self-organizing Kitchen");
        for (const request of completion.workRequests)
          expandWork(draft, this.policyPack(draft.team), binding, request, events);
      }
      applyReport(draft, this.pack(draft.team), binding, completion.report, events);
      events.push({
        type: "recovery.report",
        actor: RUNTIME,
        workItemId: item.id,
        text: "Recovered the worker's completed report",
      });
      return true;
    }
    return false;
  }

  async startTeam(params: {
    bossAgentId: string;
    title: string;
    objective: string;
    cwd?: string;
    packId?: string;

    force?: boolean;
    kitchen?: Team["kitchen"];
    acceptanceCriteria?: Array<{ id: string; text: string }>;
    roleProfiles?: Record<string, RoleProfileOverride>;
    policy?: Team["policy"];
    workflowSnapshot?: WorkflowDefinition;
  }): Promise<TeamState> {
    const boss = await this.options.controller.get(params.bossAgentId);
    if (!boss) throw new Error(`Boss agent ${params.bossAgentId} not found`);
    if (boss.labels?.[TEAM_ROLE_LABEL]) throw new Error("Team members cannot start teams");
    const cwd = params.cwd ?? boss.cwd;
    const profile = await readProjectProfile(cwd);
    const resolved = params.workflowSnapshot
      ? packFromSnapshot(params.workflowSnapshot)
      : await this.options.packs.resolveFor(cwd, params.packId ?? profile.workflowPack);
    const pack = resolved ? this.limitPack(resolved) : undefined;
    if (!pack)
      throw new Error(`Workflow pack ${params.packId ?? profile.workflowPack} is not installed`);
    const defaultProfile = bossProfile(boss);
    const roleProfiles = await this.resolveRoleProfiles(
      pack,
      cwd,
      defaultProfile,
      profile.roles,
      params.roleProfiles,
    );
    const { state, events } = createTeamState({
      pack,
      title: params.title,
      objective: params.objective,
      cwd,
      baseBranch: await currentBranch(cwd),
      bossAgentId: params.bossAgentId,
      roleProfiles,
    });
    state.team.runtime = runtimeState(params.policy, this.capacity());
    state.team.policy = params.policy;
    if (params.workflowSnapshot)
      state.team.workflowSnapshot = structuredClone(params.workflowSnapshot);
    if (params.kitchen) state.team.kitchen = params.kitchen;
    if (params.acceptanceCriteria)
      state.items[state.team.rootItemId]!.acceptanceCriteria = params.acceptanceCriteria;
    await this.store.create(state, events);
    await this.syncKitchenBoss(state.team);
    await this.store.commit(state.team.id, (draft) => {
      const out: TeamEventDraft[] = [];
      schedule(draft, pack, out);
      return { events: out, result: null };
    });
    void this.dispatchAll();
    return (await this.store.get(state.team.id))!;
  }

  private async policyObservation(
    state: TeamState,
    pendingDecisionId?: string,
  ): Promise<PolicyObservation> {
    return {
      activeMs: state.team.runtime?.usage.activeMs ?? 0,
      roleActiveMs: state.team.runtime?.usage.roleActiveMs ?? {},
      startedAgents: new Set(
        Object.values(state.bindings)
          .map((binding) => binding.agentId)
          .filter(Boolean),
      ).size,
      delegationDepth: Math.max(
        0,
        ...Object.values(state.items).map((item) => Number(item.pack.delegationDepth ?? 0)),
      ),
      delegatedItems: Object.values(state.items).filter(
        (item) => typeof item.pack.workRequest === "string",
      ).length,
      usage: await this.options.policyUsage?.(state),
      chainSteps: Object.values(state.decisions)
        .filter((decision) =>
          ["start-role", "message-role", "invoke-pack-action"].includes(decision.kind),
        )
        .reduce(
          (total, decision) =>
            total +
            Math.max(
              0,
              decision.attempts -
                (decision.id === pendingDecisionId && decision.status === "leased" ? 1 : 0),
            ),
          0,
        ),
      outcomeJudgeAvailable: Boolean(
        this.options.decisionSource || this.options.independentChecks?.judge,
      ),
    };
  }

  private normalizeSingleProfiles(
    pack: WorkflowPack,
    profiles?: Record<string, RoleProfileOverride>,
  ): Record<string, RoleProfileOverride> | undefined {
    if (pack.id !== "kitchen-single" || !profiles) return profiles;
    const original = this.options.packs.get("kitchen");
    const normalized: Record<string, RoleProfileOverride> = {};
    for (const [role, profile] of Object.entries(profiles)) {
      if (pack.roles[role]) normalized[role] = profile;
      else if (!original?.roles[role]) throw new Error(`Unknown workflow role ${role}`);
    }
    if (!normalized.integrator && profiles.developer) normalized.integrator = profiles.developer;
    return normalized;
  }

  private async resolveRoleProfiles(
    pack: WorkflowPack,
    cwd: string,
    base: Team["roleProfiles"][string],
    project?: Record<string, RoleProfileOverride>,
    overrides?: Record<string, RoleProfileOverride>,
  ): Promise<Team["roleProfiles"]> {
    project = this.normalizeSingleProfiles(pack, project);
    overrides = this.normalizeSingleProfiles(pack, overrides);
    const defaults = this.normalizeSingleProfiles(pack, this.options.roleProfiles?.());
    for (const role of [...Object.keys(project ?? {}), ...Object.keys(overrides ?? {})]) {
      if (!pack.roles[role]) throw new Error(`Unknown workflow role ${role}`);
    }
    const profiles: Team["roleProfiles"] = {};
    for (const role of Object.keys(pack.roles)) {
      const configured = await this.profiles.resolve(
        base,
        project?.[role] ?? defaults?.[role],
        role,
        pack.id,
      );
      const resolved = await this.profiles.resolve(configured, overrides?.[role], role, pack.id);
      if (this.options.controller.validateProvider)
        await this.options.controller.validateProvider({ ...resolved, cwd });
      profiles[role] = resolved;
    }
    return profiles;
  }

  private executedRoleProfile(
    state: TeamState,
    item: WorkItem,
    role: string,
  ): Team["roleProfiles"][string] | undefined {
    const binding = activeBinding(state, item, role);
    if (binding) return binding.executedProfile ?? state.team.roleProfiles[role];
    return item.roleProfiles?.[role] ?? state.team.roleProfiles[role];
  }

  private appendRoleWorkflow(
    state: TeamState,
    item: WorkItem,
    role: string,
    lines: string[],
  ): void {
    const profile = this.executedRoleProfile(state, item, role);
    if (profile?.instructions)
      lines.push("", "## Configured role instructions", profile.instructions);
    if (profile?.steps?.length)
      lines.push(
        "",
        "## Configured workflow steps",
        "Complete these steps in order within this role. The pack's report outcomes and verification requirements still apply.",
        ...profile.steps.map(
          (step, index) => `${index + 1}. ${step.title} [${step.id}]\n${step.instructions}`,
        ),
      );
  }

  private async selectedWorkflow(id?: string) {
    return id ? this.workflows.get(id) : undefined;
  }
  async workflowTemplates() {
    return ["kitchen", "kitchen-single"].map((id) =>
      definitionFromPack(this.options.packs.get(id)!, id),
    );
  }
  async previewWorkflow(input: {
    id: string;
    basePackId: string;
    cwd: string;
    request: string;
    expectedRevision: number;
    role?: string;
  }) {
    const current = (await this.workflows.list()).find((entry) => entry.id === input.id);
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new Error("Workflow revision conflict");
    const base = this.options.packs.get(input.basePackId);
    if (!base) throw new Error("Workflow base pack not found");
    const definition = current ?? definitionFromPack(base, input.id);
    if (definition.basePackId !== input.basePackId) throw new Error("Workflow base pack conflict");
    if (!this.options.decisionSource?.designWorkflow)
      throw new Error("Configure System One before requesting a workflow preview");
    const result = await this.options.decisionSource.designWorkflow({
      definition,
      cwd: input.cwd,
      request: input.request,
      role: input.role,
    });
    if (
      result.definition.id !== definition.id ||
      result.definition.revision !== definition.revision
    )
      throw new Error("Workflow design changed immutable identity or revision");
    return this.workflows.preview(result.definition, result);
  }

  async saveProfile(profile: WorkflowProfile, cwd: string): Promise<WorkflowProfile> {
    const directory = await realpath(cwd);
    if (profile.profile.provider)
      await this.options.controller.validateProvider({
        ...profile.profile,
        provider: profile.profile.provider,
        cwd: directory,
      });
    else if (profile.profile.model) throw new Error("A saved model requires its provider");
    return this.profiles.save(profile);
  }

  async configureWork(
    teamId: string,
    workItemId: string,
    role: string,
    profile: RoleProfileOverride,
    actorId: string,
  ): Promise<TeamState> {
    const state = await this.store.get(teamId);
    if (!state) throw new Error(`Team ${teamId} not found`);
    assertMutableTeam(state.team);
    const base = state.team.roleProfiles[role];
    if (!base) throw new Error(`Unknown workflow role ${role}`);
    const resolved = await this.profiles.resolve(
      base,
      RoleProfileOverrideSchema.parse(profile),
      role,
      state.team.packId,
    );
    await this.options.controller.validateProvider({ ...resolved, cwd: state.team.cwd });
    await this.store.commit(teamId, (draft) => {
      if (draft.team.status === "done" || draft.team.status === "canceled")
        throw new Error("Closed jobs cannot be configured");
      const item = draft.items[workItemId];
      if (!item) throw new Error(`Work item ${workItemId} not found`);
      if (isTerminal(this.pack(draft.team), item))
        throw new Error("Completed work items cannot be configured");
      if (
        Object.values(draft.decisions).some(
          (decision) =>
            decision.workItemId === workItemId &&
            decision.kind === "start-role" &&
            decision.payload.role === role &&
            decision.status === "leased",
        )
      )
        throw new Error("Role dispatch is in progress; pause and try again after it settles");
      (item.roleProfiles ??= {})[role] = resolved;
      return {
        events: [
          {
            type: "role.configured",
            actor: { type: "human" as const, id: actorId },
            workItemId,
            text: `Configured ${role} for the next agent`,
            data: { profile: resolved },
          },
        ],
        result: null,
      };
    });
    return (await this.store.get(teamId))!;
  }

  listPacks(): WorkflowPack[] {
    return this.options.packs.list();
  }

  startKitchen(params: StartKitchenInput): Promise<TeamState> {
    const previous = this.kitchenStarts.get(params.idempotencyKey);
    if (previous)
      return previous.then((state) => {
        if (
          (state.team.kitchen?.requests?.[params.idempotencyKey] ??
            state.team.kitchen?.requestFingerprint) !== requestFingerprint(params)
        ) {
          throw new Error("Idempotency key already belongs to another Kitchen request");
        }
        return state;
      });
    const started = this.kitchenStartChain
      .catch(() => {})
      .then(() => this.createKitchen(params))
      .finally(() => this.kitchenStarts.delete(params.idempotencyKey));
    this.kitchenStartChain = started;
    this.kitchenStarts.set(params.idempotencyKey, started);
    return started;
  }

  private async createKitchen(params: StartKitchenInput): Promise<TeamState> {
    validateKitchenInput(params);
    const fingerprint = requestFingerprint(params);
    const previous = await this.findKitchenRequest(params.idempotencyKey, fingerprint);
    if (previous) {
      await this.syncKitchenBoss(previous.team);
      return previous;
    }
    if (params.policy)
      assertPolicyAllows(params.policy, {
        startedAgents: 0,
        delegationDepth: 0,
        delegatedItems: 0,
        activeMs: 0,
        roleActiveMs: {},
        chainSteps: 0,
        usage: this.options.policyUsage
          ? { scope: "team", complete: true, cumulative: true, tokens: 0, costUsd: 0 }
          : undefined,
        outcomeJudgeAvailable: Boolean(
          this.options.decisionSource || this.options.independentChecks?.judge,
        ),
      });
    let resolvedMode = params.executionMode;
    let classification: NonNullable<NonNullable<Team["kitchen"]>["classification"]> | undefined;
    if (params.executionMode === "auto") {
      if (!this.options.decisionSource)
        throw new Error(
          "Configure the host's System One decision source before automatic Lead routing",
        );
      classification = await this.options.decisionSource.classify(params);
      if (classification.executionMode === "human")
        throw new Error(`Lead routing requires human clarification: ${classification.reason}`);
    }
    if (classification && classification.executionMode !== "human")
      resolvedMode = classification.executionMode;
    const workflowSnapshot = await this.selectedWorkflow(params.workflowId);
    const effective = {
      ...params,
      executionMode: resolvedMode,
      roleProfiles: mergeWorkflowProfiles(workflowSnapshot?.roleProfiles, params.roleProfiles),
    };
    const { cwd, pack, criteria, workspaceId } = await this.prepareKitchen(effective);
    const active = await this.findActiveKitchen(params, cwd, pack.id, fingerprint);
    if (active) return active;
    const claim = await this.reserveKitchenRequest(params, cwd, pack.id, fingerprint);
    const existingBoss = await this.findKitchenBoss(claim, fingerprint);
    const bossAgentId =
      existingBoss?.id ??
      (await this.createKitchenBoss(params, cwd, claim, fingerprint, workspaceId));
    const requests: Record<string, string> = { [params.idempotencyKey]: fingerprint };
    const previousKey = existingBoss?.labels?.[`${KITCHEN_REQUEST_LABEL}.key`];
    if (previousKey)
      requests[previousKey] = existingBoss!.labels[`${KITCHEN_REQUEST_LABEL}.fingerprint`]!;
    return this.startTeam({
      bossAgentId,
      title: params.title,
      objective: params.objective,
      cwd,
      packId: pack.id,
      force: true,
      acceptanceCriteria: criteria,
      roleProfiles: effective.roleProfiles,
      workflowSnapshot,
      policy: params.policy,
      kitchen: {
        idempotencyKey: params.idempotencyKey,
        requestFingerprint: fingerprint,
        mode: "accompanied",
        workflowMode: kitchenWorkflowMode(params),
        missionMode: kitchenMissionMode(params),
        executionMode: workflowExecutionMode(workflowSnapshot, pack),
        classification,
        spec: params.spec,
        publication: params.publication,
        scheduleId: params.scheduleId,
        kind: params.kind ?? "feature",
        sourceAgentId: params.sourceAgentId,
        requests,
      },
    });
  }

  private async findKitchenRequest(key: string, fingerprint: string): Promise<TeamState | null> {
    for (const id of await this.store.listIds()) {
      const existing = await this.store.get(id);
      const previous = existing?.team.kitchen;
      if (!existing || !previous || (previous.idempotencyKey !== key && !previous.requests?.[key]))
        continue;
      if ((previous.requests?.[key] ?? previous.requestFingerprint) !== fingerprint)
        throw new Error("Idempotency key already belongs to another Kitchen request");
      return existing;
    }
    return null;
  }

  private async prepareKitchen(params: StartKitchenInput): Promise<PreparedKitchen> {
    if (!isAbsolute(params.cwd)) throw new Error("Kitchen cwd must be an absolute path");
    const cwd = await realpath(params.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Kitchen cwd must be a directory");
    await this.validateKitchenSource(params, cwd);
    const profile = await readProjectProfile(cwd);
    const requestedPack = params.packId ?? profile.workflowPack ?? "kitchen";
    if (params.executionMode === "single" && !["kitchen", "kitchen-single"].includes(requestedPack))
      throw new Error("Single execution requires the kitchen-single pack");
    if (params.executionMode === "team" && requestedPack === "kitchen-single")
      throw new Error("Team execution cannot use the single pack");
    const packId = params.executionMode === "single" ? "kitchen-single" : requestedPack;
    const definition = params.workflowId ? await this.workflows.get(params.workflowId) : undefined;
    if (
      definition &&
      params.executionMode === "single" &&
      definition.basePackId !== "kitchen-single"
    )
      throw new Error("Single execution requires a single workflow variant");
    const pack = definition
      ? packFromSnapshot(definition)
      : await this.options.packs.resolveFor(cwd, packId);
    if (!pack) throw new Error(`Workflow pack ${packId} is not installed`);
    if (!this.options.controller.validateProvider)
      throw new Error("Kitchen provider preflight is not configured");
    const criteria = z
      .array(z.object({ id: z.string().min(1), text: z.string().min(1) }))
      .parse(params.acceptanceCriteria);
    if (pack.requireVerification && !criteria?.length)
      throw new Error("Kitchen acceptance criteria are required");
    await this.options.controller.validateProvider({
      provider: params.provider,
      model: params.model,
      cwd,
    });
    await this.resolveRoleProfiles(
      pack,
      cwd,
      {
        provider: params.provider,
        model: params.model,
        mode: params.mode,
        thinking: params.thinking,
      },
      profile.roles,
      params.roleProfiles,
    );
    const workspaceId = await this.kitchenWorkspace(params, cwd);
    return { cwd, pack, criteria, workspaceId };
  }

  private async kitchenWorkspace(
    params: StartKitchenInput,
    cwd: string,
  ): Promise<string | undefined> {
    const source = params.sourceAgentId
      ? await this.options.controller.get(params.sourceAgentId)
      : null;
    const sourceMatches = source && (await realpath(source.cwd)) === cwd;
    const id = params.workspaceId ?? (sourceMatches ? source?.workspaceId : undefined);
    if (id) {
      if (!this.options.controller.resolveWorkspace)
        throw new Error("Kitchen workspace resolver is not configured");
      const workspace = await this.options.controller.resolveWorkspace(id);
      if (!workspace || workspace.archivedAt) throw new Error("Kitchen workspace is unavailable");
      if ((await realpath(workspace.cwd)) !== cwd)
        throw new Error("Kitchen workspace must match the selected directory");
      return workspace.id;
    }
    const workspace = await this.options.controller.findWorkspaceForCwd?.(cwd);
    if (!workspace) return undefined;
    if ((await realpath(workspace.cwd)) !== cwd)
      throw new Error("Kitchen workspace must match the selected directory");
    return workspace.id;
  }

  async isProtectedKitchenBoss(agentId: string): Promise<boolean> {
    return (await this.listForBoss(agentId)).some(
      (state) =>
        state.team.kitchen && state.team.status !== "done" && state.team.status !== "canceled",
    );
  }

  async assertCanArchiveAgent(agentId: string): Promise<void> {
    if (await this.isProtectedKitchenBoss(agentId))
      throw new Error("Finish or cancel the Kitchen before closing its session");
  }

  private async syncKitchenBoss(team: Team): Promise<void> {
    if (!team.kitchen) return;
    const boss = await this.options.controller.get(team.bossAgentId);
    if (!boss) return;
    await this.repairKitchenWorkspace(team, boss);
    if (boss.parentAgentId) await this.options.controller.detach(team.bossAgentId);
    const labels: Record<string, string> = {
      ...boss.labels,
      [TEAM_LABEL]: team.id,
      "agent-factory.team.boss": "true",
      "agent-factory.team.status": team.status,
    };

    if (boss.title === team.title && JSON.stringify(labels) === JSON.stringify(boss.labels)) return;
    await this.options.controller.update(team.bossAgentId, {
      title: team.title,
      labels,
    });
  }

  private async repairKitchenWorkspace(team: Team, boss: FactoryAgent): Promise<void> {
    if (!team.kitchen?.sourceAgentId || !this.options.controller.resolveWorkspace) return;
    const source = await this.options.controller.get(team.kitchen.sourceAgentId);
    if (!source?.workspaceId || source.workspaceId === boss.workspaceId) return;
    const workspace = await this.options.controller.resolveWorkspace(source.workspaceId);
    if (!workspace || workspace.archivedAt) return;
    const cwd = boss.cwd;
    const directories = await Promise.all(
      [cwd, source.cwd, workspace.cwd].map((path) => realpath(path).catch(() => null)),
    );
    if (!directories[0] || directories.some((directory) => directory !== directories[0])) return;
    await this.options.controller.moveToWorkspace(boss.id, workspace.id);
  }

  private async validateKitchenSource(params: StartKitchenInput, cwd: string): Promise<void> {
    if (!params.sourceAgentId) return;
    const source = await this.options.controller.get(params.sourceAgentId);
    if (!source) throw new Error("Source session not found");
    if (source.labels?.[TEAM_ROLE_LABEL])
      throw new Error("Team Cooks cannot hand off to another Kitchen");
    const sourceCwd = await realpath(source.cwd);
    if (sourceCwd !== cwd) {
      const [sourceRepo, kitchenRepo] = await Promise.all([
        gitRepository(sourceCwd),
        gitRepository(cwd),
      ]);
      if (sourceRepo !== kitchenRepo)
        throw new Error("Kitchen must stay in the source session project");
    }
    if (source.provider !== params.provider.split("/")[0])
      throw new Error("Kitchen provider must match the source session provider");
  }

  private async findActiveKitchen(
    params: StartKitchenInput,
    cwd: string,
    packId: string,
    fingerprint: string,
  ): Promise<TeamState | null> {
    for (const id of await this.store.listIds()) {
      const existing = await this.store.get(id);
      if (!existing || existing.team.status === "done" || existing.team.status === "canceled")
        continue;
      const root = existing.items[existing.team.rootItemId];
      if (root?.phase === "done" || root?.phase === "canceled") continue;
      const sameSchedule =
        params.scheduleId && existing.team.kitchen?.scheduleId === params.scheduleId;
      const sameJob =
        existing.team.cwd === cwd &&
        existing.team.objective === params.objective &&
        existing.team.packId === packId;
      if ((!sameSchedule && !sameJob) || !existing.team.kitchen) continue;
      if (existing.team.kitchen.requestFingerprint !== fingerprint)
        throw new Error(
          "An active Kitchen owns this job with different criteria, workflow or session settings",
        );
      await this.store.commit(id, (draft) => {
        const kitchen = draft.team.kitchen!;
        kitchen.requests ??= { [kitchen.idempotencyKey]: kitchen.requestFingerprint };
        kitchen.requests[params.idempotencyKey] = fingerprint;
        return { events: [], result: null };
      });
      return (await this.store.get(id))!;
    }
    return null;
  }

  private async reserveKitchenRequest(
    params: StartKitchenInput,
    cwd: string,
    packId: string,
    fingerprint: string,
  ): Promise<KitchenClaim> {
    const requestId = createHash("sha256").update(params.idempotencyKey).digest("hex");
    const claim = createHash("sha256")
      .update(JSON.stringify({ cwd, objective: params.objective, packId }))
      .digest("hex");
    const path = join(this.options.storageRoot, "kitchen-requests", `${requestId}.json`);
    try {
      const reservation = JSON.parse(await readFile(path, "utf8")) as { fingerprint: string };
      if (reservation.fingerprint !== fingerprint)
        throw new Error("Idempotency key already belongs to another Kitchen request");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeJsonFileAtomic(path, { fingerprint, claim, createdAt: this.now().toISOString() });
    return { requestId, claim };
  }

  private async findKitchenBoss(
    claim: KitchenClaim,
    fingerprint: string,
  ): Promise<FactoryAgent | undefined> {
    const agents = await this.options.controller.list();
    const assignedBosses = new Set<string>();
    for (const id of await this.store.listIds()) {
      const state = await this.store.get(id);
      if (state) assignedBosses.add(state.team.bossAgentId);
    }
    const existing = agents.find(
      (agent) =>
        agent.labels?.[KITCHEN_REQUEST_LABEL] === claim.requestId ||
        (agent.labels?.[`${KITCHEN_REQUEST_LABEL}.claim`] === claim.claim &&
          !agent.archivedAt &&
          !agent.labels?.[TEAM_ROLE_LABEL] &&
          !assignedBosses.has(agent.id)),
    );
    if (
      existing?.labels?.[KITCHEN_REQUEST_LABEL] === claim.requestId &&
      existing.labels?.[`${KITCHEN_REQUEST_LABEL}.fingerprint`] !== fingerprint
    )
      throw new Error("Idempotency key already belongs to another Kitchen request");
    return existing;
  }

  private async createKitchenBoss(
    params: StartKitchenInput,
    cwd: string,
    claim: KitchenClaim,
    fingerprint: string,
    workspaceId?: string,
  ): Promise<string> {
    const created = await this.options.controller.create({
      provider: params.model ? `${params.provider}/${params.model}` : params.provider,
      title: params.title,
      cwd,
      workspaceId,
      mode: params.mode,
      thinking: params.thinking,
      decisionId: claim.requestId,
      labels: {
        [KITCHEN_REQUEST_LABEL]: claim.requestId,
        [`${KITCHEN_REQUEST_LABEL}.fingerprint`]: fingerprint,
        [`${KITCHEN_REQUEST_LABEL}.claim`]: claim.claim,
        [`${KITCHEN_REQUEST_LABEL}.key`]: params.idempotencyKey,
        "agent-factory.team.boss": "true",
      },
    });
    return created.id;
  }

  async controlKitchen(
    teamId: string,
    action: "pause" | "resume" | "stop" | "cancel" | "accept",
    actorId: string,
    approval?: { credential?: string; candidateCommit?: string },
  ): Promise<TeamState> {
    await this.store.commit(teamId, async (draft) => {
      assertMutableTeam(draft.team);
      const runtime = (draft.team.runtime ??= runtimeState(draft.team.policy, this.capacity()));
      if (action === "accept")
        return { events: await this.acceptKitchen(draft, actorId, approval), result: null };
      if (draft.team.status === "canceled" || draft.team.status === "done") {
        if (action === "cancel" && draft.team.status === "canceled")
          return { events: [], result: null };
        throw new Error("Finished Kitchen cannot resume or change state");
      }
      if (action === "resume") {
        if (runtime.limitReason) throw new Error(`Kitchen limit reached: ${runtime.limitReason}`);
        const pack = this.pack(draft.team);
        if (pack.version !== draft.team.packVersion)
          throw new Error("Workflow pack version does not match");
        draft.team.status = "active";
        draft.team.pausedReason = undefined;
        if (draft.team.kitchen) draft.team.kitchen.stopped = false;
        schedule(draft, pack, []);
      } else {
        draft.team.status = action === "cancel" ? "canceled" : "paused";
        draft.team.pausedReason = action;
        if (action === "stop" || action === "cancel") {
          if (draft.team.kitchen) draft.team.kitchen.stopped = true;
          for (const decision of Object.values(draft.decisions)) {
            if (["pending", "retry", "leased", "proposed"].includes(decision.status)) {
              decision.status = "superseded";
              decision.leaseExpiresAt = undefined;
            }
          }
          for (const binding of Object.values(draft.bindings)) {
            if (binding.status !== "active") continue;
            chargeBinding(draft, binding, this.now().getTime());
            binding.status = "revoked";
            binding.revokedAt = this.now().toISOString();
          }
        }
      }
      return {
        events: [
          {
            type: `team.${action}`,
            actor: { type: "human", id: actorId },
            text: `Kitchen ${action}`,
          },
        ],
        result: null,
      };
    });
    if (action === "stop" || action === "cancel") {
      await this.dispatchRun;
      await this.interruptTeam(teamId);
    } else if (action === "resume") {
      await this.healthAll();
    }
    const state = (await this.store.get(teamId))!;
    await this.syncKitchenBoss(state.team);
    return state;
  }

  async publish(teamId: string, credential: string, candidateCommit: string): Promise<TeamState> {
    await this.store.commit(teamId, async (draft) => {
      assertMutableTeam(draft.team);
      const kitchen = draft.team.kitchen;
      if (draft.team.status !== "done" || !kitchen?.acceptedCommit || !kitchen.approval)
        throw new Error("Publication requires a verified, operator-approved accepted mission");
      verifyOperatorApproval({
        configuredCredential: await this.options.operatorCredential?.(),
        suppliedCredential: credential,
        requestedCommit: candidateCommit,
        candidateCommit: kitchen.acceptedCommit,
        now: this.now(),
      });
      if (!kitchen.publication?.enabled)
        throw new Error("PR publication has not been explicitly enabled for this mission");
      if (kitchen.published) return { events: [], result: null };
      if (!this.options.publicationCli)
        throw new Error("Configure a trusted publication CLI on this host before publishing");
      const root = draft.items[draft.team.rootItemId]!;
      const verifier = draft.bindings[root.bindings.verifier ?? ""];
      const agent = verifier ? await this.options.controller.get(verifier.agentId) : null;
      if (!agent) throw new Error("Verified publication checkout is unavailable");
      await this.assertVerifiedCheckout(agent.cwd, candidateCommit);
      const url = await publishCandidate(
        agent.cwd,
        candidateCommit,
        kitchen.publication,
        this.options.publicationCli,
        this.options.publicationRunner,
      );
      kitchen.published = { commit: candidateCommit, url, at: this.now().toISOString() };
      root.artifacts.push({ kind: "pr", ref: url, note: `Published verified ${candidateCommit}` });
      return {
        events: [
          {
            type: "publication.completed",
            actor: RUNTIME,
            workItemId: root.id,
            text: `Published verified candidate ${url}`,
            data: { commit: candidateCommit, url },
          },
        ],
        result: null,
      };
    });
    return (await this.store.get(teamId))!;
  }

  private async validateAcceptance(
    draft: TeamState,
    root: WorkItem,
    commit: string,
  ): Promise<void> {
    if (
      !root.acceptanceCriteria.length ||
      root.acceptanceCriteria.some((criterion) => !criterion.met || !criterion.evidence?.trim())
    )
      throw new Error("Kitchen acceptance requires verified evidence for every criterion");
    if (
      (
        await Promise.all(
          Object.values(draft.bindings)
            .filter((binding) => binding.agentId)
            .map((binding) => this.options.controller.isRunning(binding.agentId)),
        )
      ).some(Boolean)
    )
      throw new Error("Wait for all Cooks to finish before accepting Kitchen");
    const verifier = draft.bindings[root.bindings.verifier ?? ""];
    const record = verifier ? await this.options.controller.get(verifier.agentId) : null;
    if (!record) throw new Error("Final verification checkout is unavailable");
    await this.assertVerifiedCheckout(record.cwd, commit);
    if (draft.team.policy) assertOutcomeJudged(draft.team.policy, root.checks ?? [], commit);
    assertBrowserEvidence(this.options.independentChecks, root.checks ?? [], commit);
    this.assertConfiguredCriteria(root, root.checks ?? [], commit);
  }

  private async acceptKitchen(
    draft: TeamState,
    actorId: string,
    approval?: { credential?: string; candidateCommit?: string },
  ): Promise<TeamEventDraft[]> {
    if (draft.team.status === "done" && draft.team.kitchen?.acceptedCommit) {
      verifyOperatorApproval({
        configuredCredential: await this.options.operatorCredential?.(),
        suppliedCredential: approval?.credential,
        requestedCommit: approval?.candidateCommit,
        candidateCommit: draft.team.kitchen.acceptedCommit,
        now: this.now(),
      });
      return [];
    }
    const { root, commit } = acceptanceCandidate(draft);
    if (!actorId.trim()) throw new Error("Human acceptance requires an actor");
    await this.validateAcceptance(draft, root, commit);
    const pack = this.pack(draft.team);
    if (!pack.boards.root.phases.done || pack.boards.root.phases.done.kind !== "terminal")
      throw new Error("Workflow pack does not support human acceptance");
    const actor: Actor = { type: "human", id: actorId };
    const events: TeamEventDraft[] = [];
    enterPhase(draft, pack, root, "done", actor, events, "accepted verified candidate");
    draft.team.status = "done";
    draft.team.pausedReason = undefined;
    draft.team.kitchen!.acceptedAt = this.now().toISOString();
    draft.team.kitchen!.acceptedBy = actorId;
    draft.team.kitchen!.acceptedCommit = commit;
    draft.team.kitchen!.approval = verifyOperatorApproval({
      configuredCredential: await this.options.operatorCredential?.(),
      suppliedCredential: approval?.credential,
      requestedCommit: approval?.candidateCommit,
      candidateCommit: commit,
      now: this.now(),
    });
    events.push({
      type: "team.accepted",
      actor,
      workItemId: root.id,
      text: `Accepted verified commit ${commit}`,
      data: { commit },
    });
    return events;
  }

  private async assertVerifiedCheckout(cwd: string, commit: string): Promise<void> {
    const [head, status] = await Promise.all([
      execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", cwd, "status", "--porcelain"]),
    ]);
    if (status.stdout.trim())
      throw new ReportRejectedError("Verification requires a clean worktree");
    if (commit !== head.stdout.trim())
      throw new ReportRejectedError("Verification commit does not match the current git HEAD");
  }

  private async interruptTeam(teamId: string): Promise<void> {
    const state = (await this.store.get(teamId))!;
    const agents = await this.options.controller.list();
    const results = await Promise.allSettled(
      agents
        .filter((agent) => agent.labels?.[TEAM_LABEL] === teamId)
        .map(async (agent) => {
          const snapshot = await this.options.controller.get(agent.id);
          if (
            !snapshot ||
            (!(await this.options.controller.isRunning(agent.id)) && !snapshot.running)
          )
            return;
          await this.options.controller.cancel(agent.id);
        }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length) {
      await this.store.commit(state.team.id, () => ({
        events: [
          {
            type: "safety.interrupt-failed",
            actor: RUNTIME,
            text: failures.map((failure) => String(failure.reason)).join("; "),
          },
        ],
        result: null,
      }));
      throw new Error(
        "Kitchen stopped scheduling, but a Cook could not be interrupted; inspect safety.interrupt-failed",
      );
    }
  }

  async status(teamId: string) {
    const state = await this.store.get(teamId);
    if (!state) throw new Error(`Team ${teamId} not found`);
    const pack = this.pack(state.team);
    const workflow = {
      maxParallel: pack.maxParallel,
      boards: pack.boards,
      roles: Object.fromEntries(
        Object.entries(pack.roles).map(([id, role]) => [id, { title: role.title }]),
      ),
    };
    return { state, events: await this.store.events(teamId), workflow };
  }

  async listForBoss(bossAgentId: string): Promise<TeamState[]> {
    const out: TeamState[] = [];
    for (const id of await this.store.listIds()) {
      const state = await this.store.get(id);
      if (state && state.team.bossAgentId === bossAgentId) out.push(state);
    }
    return out;
  }

  async message(teamId: string, text: string, actor: Actor): Promise<void> {
    const bossId = await this.store.commit(teamId, (draft) => {
      assertMutableTeam(draft.team);
      if (["done", "canceled"].includes(draft.team.status)) throw new Error("This team is closed");
      const events: TeamEventDraft[] = [{ type: "human.message", actor, text }];
      for (const item of Object.values(draft.items)) {
        if (item.phase === "blocked") {
          delete item.pack.headChefQuestion;
          item.reports.push({ role: "boss", phase: "blocked", outcome: "answer", summary: text });
          item.returns = 0;
          const pack = this.pack(draft.team);
          const lastWorking = item.phaseHistory.findLast(
            (h) => boardOf(pack, item).phases[h.phase]?.kind === "working",
          );
          if (lastWorking) {
            enterPhase(draft, pack, item, lastWorking.phase, actor, events, "boss answered");
          }
          continue;
        }
        const phase = boardOf(this.pack(draft.team), item).phases[item.phase];
        const seat = phase?.role ? activeBinding(draft, item, phase.role) : null;
        const waiting =
          seat && (seat.turn === "idle" || (seat.turn === "reported" && seat.phase === item.phase));
        if (seat && waiting) {
          seat.turn = "starting";
          seat.nudges = 0;
          addDecision(
            draft,
            item,
            "message-role",
            { bindingId: seat.id, note: text },
            `answer:${seat.id}:${draft.commit}`,
          );
        }
      }
      return { events, result: draft.team.bossAgentId };
    });
    if (actor.type === "human") await this.options.controller.send(bossId, text, "steer");
    void this.dispatchAll();
  }

  async retryDecision(teamId: string, decisionId: string, actorId: string): Promise<void> {
    await this.store.commit(teamId, (draft) => {
      const decision = draft.decisions[decisionId];
      if (
        !decision ||
        (!["retry", "failed"].includes(decision.status) &&
          !(decision.status === "pending" && decision.payload.retry === true))
      )
        throw new Error("Only failed or waiting retry decisions can be retried");
      assertMutableTeam(draft.team);
      if (["done", "canceled"].includes(draft.team.status)) throw new Error("This team is closed");
      if (
        typeof decision.payload.routingResetAt === "string" &&
        Date.parse(decision.payload.routingResetAt) > this.now().getTime()
      )
        throw new Error(
          `Host routing is waiting until ${decision.payload.routingResetAt}; retry after the reported reset`,
        );
      const item = draft.items[decision.workItemId];
      if (!item) throw new Error("Work item missing");
      const events: TeamEventDraft[] = [];
      const actor: Actor = { type: "human", id: actorId };
      if (item.phase === "blocked") {
        const pack = this.pack(draft.team);
        const last = item.phaseHistory.findLast(
          (history) => boardOf(pack, item).phases[history.phase]?.kind === "working",
        );
        if (!last) throw new Error("No working phase available to retry");
        decision.status = "superseded";
        item.returns = 0;
        enterPhase(draft, pack, item, last.phase, actor, events, "manual retry");
      } else {
        if (item.phase !== decision.phase) throw new Error("Decision belongs to a previous phase");
        decision.status = "retry";
        decision.attempts = 0;
        decision.availableAt = this.now().toISOString();
        decision.lastError = undefined;
      }
      events.push({
        type: "decision.retried",
        actor,
        workItemId: item.id,
        text: "Retry requested",
      });
      return { events, result: null };
    });
    void this.dispatchAll();
  }

  async setStatus(
    teamId: string,
    status: "active" | "paused" | "canceled",
    actorId: string,
  ): Promise<void> {
    const state = await this.store.get(teamId);
    if (state?.team.kitchen) {
      await this.controlKitchen(
        teamId,
        { active: "resume", paused: "pause", canceled: "cancel" }[status] as
          | "resume"
          | "pause"
          | "cancel",
        actorId,
      );
      return;
    }
    await this.store.commit(teamId, (draft) => {
      assertMutableTeam(draft.team);
      if (["done", "canceled"].includes(draft.team.status)) throw new Error("This team is closed");
      draft.team.status = status;
      if (status === "active") draft.team.pausedReason = undefined;
      const events: TeamEventDraft[] = [
        { type: `team.${status}`, actor: { type: "boss", id: actorId }, text: `Team ${status}` },
      ];
      if (status === "active") schedule(draft, this.pack(draft.team), events);
      return { events, result: null };
    });
    void this.dispatchAll();
  }

  async resolveCaller(agentId: string): Promise<TeamCallerBinding | null> {
    const labels = (await this.options.controller.get(agentId))?.labels;
    const teamId = labels?.[TEAM_LABEL];
    if (!teamId || !labels?.[TEAM_ROLE_LABEL]) return null;
    const state = await this.store.get(teamId);
    const binding = state ? findSeat(state, agentId, labels[TEAM_DECISION_LABEL]) : undefined;
    return binding ? { teamId, binding } : null;
  }

  async report(
    agentId: string,
    payload: TeamReportPayload,
    items?: PlannedItem[],
    workRequests?: WorkRequestInput[],
  ): Promise<string> {
    const caller = await this.resolveCaller(agentId);
    if (!caller) throw new ReportRejectedError("This session is not seated in a team");
    const team = await this.store.get(caller.teamId);
    if (team) assertMutableTeam(team.team);
    const role = team ? this.pack(team.team).roles[caller.binding.role] : undefined;
    this.assertCommunication(role, payload, team);
    const checks = await this.verifyReportCheckout(
      agentId,
      team,
      team ? this.pack(team.team).roles[caller.binding.role] : undefined,
      payload,
    );
    if (checks.length) {
      await this.store.commit(caller.teamId, (draft) => {
        const item = draft.items[caller.binding.workItemId];
        if (item) item.checks = checks;
        return {
          events: [
            {
              type: "evidence.checked",
              actor: RUNTIME,
              workItemId: caller.binding.workItemId,
              text: checks.every((check) => check.passed)
                ? "Independent checks passed"
                : "Independent checks failed",
              data: { checks },
            },
          ],
          result: null,
        };
      });
      if (checks.some((check) => !check.passed))
        throw new ReportRejectedError("Independent evidence or protected-file verification failed");
    }
    const branch =
      role?.workspace === "own-worktree"
        ? await currentBranch((await this.options.controller.get(agentId))?.cwd ?? "")
        : undefined;
    try {
      const result = await this.store.commit(caller.teamId, (draft) => {
        assertMutableTeam(draft.team);
        const binding = draft.bindings[caller.binding.id]!;
        const events: TeamEventDraft[] = [];
        const target = draft.items[binding.workItemId];
        if (branch && target && binding.phase === target.phase) {
          target.artifacts = target.artifacts.filter((a) => a.kind !== "branch");
          target.artifacts.push({ kind: "branch", ref: branch });
        }
        if (items) planItems(draft, this.pack(draft.team), binding, items, events);
        if (workRequests?.length) {
          if (draft.team.kitchen?.workflowMode !== "self-organizing")
            throw new ReportRejectedError("Work requests require a self-organizing Kitchen");
          for (const input of workRequests)
            expandWork(draft, this.policyPack(draft.team), binding, input, events);
        }
        chargeBinding(draft, binding, this.now().getTime());
        const item = applyReport(draft, this.pack(draft.team), binding, payload, events);
        return {
          events,
          result: `Report accepted. ${item.title} is now in ${item.phase}. Stop here.`,
        };
      });
      if (payload.needs?.kind === "head-chef")
        await this.askHeadChef(caller.teamId, caller.binding.workItemId, payload.needs.text);
      void this.dispatchAll();
      return result;
    } catch (error) {
      if (error instanceof ReportRejectedError) {
        await this.store.commit(caller.teamId, () => ({
          events: [
            {
              type: "report.rejected",
              actor: { type: "role", id: caller.binding.role },
              workItemId: caller.binding.workItemId,
              text: error.message,
            },
          ],
          result: null,
        }));
      }
      throw error;
    }
  }

  private assertCommunication(
    role: Role | undefined,
    payload: TeamReportPayload,
    state: TeamState | null,
  ) {
    if (payload.needs?.kind !== "head-chef") return;
    if (["requirements", "irreversible"].includes(payload.needs.category ?? ""))
      throw new ReportRejectedError(
        "Requirements and irreversible-action decisions must route to a human",
      );
    const architectureAllowed =
      payload.needs.category === "architecture" &&
      state?.team.workflowSnapshot?.autonomy?.architecture === "head-chef";
    if (
      !architectureAllowed &&
      (role as WorkflowDefinition["roles"][string] | undefined)?.communication?.clarification !==
        "head-chef"
    )
      throw new ReportRejectedError("This role routes clarification to the human, not Head Chef");
  }

  private async askHeadChef(teamId: string, workItemId: string, text: string) {
    const prompt = await this.store.commit(teamId, (draft) => {
      const item = draft.items[workItemId];
      if (!item || item.phase !== "blocked") return { events: [], result: null };
      const request = { requestId: newId("question"), workItemId, revision: item.revision };
      item.pack.headChefQuestion = request;
      return {
        events: [
          {
            type: "communication.head-chef-requested",
            actor: RUNTIME,
            workItemId,
            text,
            data: request,
          },
        ],
        result: { bossId: draft.team.bossAgentId, request },
      };
    });
    if (!prompt) return;
    try {
      await this.options.controller.send(
        prompt.bossId,
        `A worker requests routine clarification: ${text}\nResolve only within the existing mission authority. Requirements or irreversible actions still need a human. Return one factory-report fence with report.outcome "head-chef-answer" and report.summary containing a JSON string with these exact fields plus answer: ${JSON.stringify(prompt.request)}. Use answer only for the scoped clarification; never approve the result, merge or deploy.`,
        "steer",
      );
    } catch (error) {
      await this.store.commit(teamId, () => ({
        events: [
          {
            type: "communication.head-chef-send-failed",
            actor: RUNTIME,
            workItemId,
            text:
              error instanceof Error
                ? error.message
                : "Head Chef unavailable; human answer remains available",
          },
        ],
        result: null,
      }));
    }
  }

  async acceptHeadChefAnswer(agentId: string, payload: TeamReportPayload): Promise<boolean> {
    if (payload.outcome !== "head-chef-answer") return false;
    const answer = z
      .object({
        requestId: z.string(),
        workItemId: z.string(),
        revision: z.number().int(),
        answer: z.string().min(1).max(16000),
      })
      .parse(JSON.parse(payload.summary));
    const teams = await this.listForBoss(agentId);
    const state = teams.find((entry) => entry.items[answer.workItemId]);
    if (!state) return false;
    await this.store.commit(state.team.id, (draft) => {
      assertMutableTeam(draft.team);
      const item = draft.items[answer.workItemId];
      const request = item?.pack.headChefQuestion as { requestId?: string } | undefined;
      if (
        draft.team.bossAgentId !== agentId ||
        draft.team.status !== "active" ||
        !item ||
        item.phase !== "blocked" ||
        item.revision !== answer.revision ||
        request?.requestId !== answer.requestId
      )
        throw new Error("Head Chef answer is stale or does not match this pending question");
      const pack = this.pack(draft.team),
        previous = item.phaseHistory.findLast(
          (history) => boardOf(pack, item).phases[history.phase]?.kind === "working",
        );
      if (!previous) throw new Error("No worker phase to resume");
      item.reports.push({
        role: "boss",
        phase: "blocked",
        outcome: "answer",
        summary: answer.answer,
      });
      delete item.pack.headChefQuestion;
      const events: TeamEventDraft[] = [
        {
          type: "communication.head-chef-answered",
          actor: { type: "boss", id: agentId },
          workItemId: item.id,
          text: answer.answer,
        },
      ];
      enterPhase(
        draft,
        pack,
        item,
        previous.phase,
        { type: "boss", id: agentId },
        events,
        "Head Chef answered",
      );
      return { events, result: null };
    });
    void this.dispatchAll();
    return true;
  }

  private needsProtectedVerification(state: TeamState, role: Role | undefined): boolean {
    if (role?.id === "verifier") return true;
    return Boolean(
      state.team.workflowSnapshot &&
      role &&
      !role.canEdit &&
      Object.values(state.team.workflowSnapshot.boards.item.phases).some(
        (phase) => phase.role === role.id && phase.condition,
      ),
    );
  }

  private async verifyReportCheckout(
    agentId: string,
    state: TeamState | null,
    role: Role | undefined,
    payload: TeamReportPayload,
  ): Promise<EvidenceResult[]> {
    if (
      !state ||
      !this.pack(state.team).requireVerification ||
      !this.needsProtectedVerification(state, role) ||
      payload.outcome !== "pass" ||
      payload.needs
    )
      return [];
    const record = await this.options.controller.get(agentId);
    if (!record) throw new ReportRejectedError("Verifier session is unavailable");
    const commits = payload.artifacts?.filter((artifact) => artifact.kind === "commit") ?? [];
    if (commits.length !== 1)
      throw new ReportRejectedError("Verification requires exactly one commit artifact");
    const commit = commits[0]!.ref;
    await this.assertVerifiedCheckout(record.cwd, commit);
    const binding = findSeat(state, agentId);
    const item = binding ? state.items[binding.workItemId] : undefined;
    const proof = item?.pack.verifierProtection as
      | { agentId: string; revision: number; snapshot: ProtectedSnapshot }
      | undefined;
    const checks: EvidenceResult[] = [];
    try {
      if (!proof || proof.agentId !== agentId || proof.revision !== item?.revision)
        throw new Error("Verifier protection snapshot unavailable for this turn");
      assertProtectedUnchanged(
        proof.snapshot,
        await (this.options.verificationSnapshot ?? captureTrackedFiles)(record.cwd),
      );
      checks.push({
        id: "verifier-boundary",
        kind: "protected-files",
        passed: true,
        summary: "Verifier left protected files, Git HEAD and worktree status unchanged",
        checkedAt: this.now().toISOString(),
        candidateCommit: commit,
      });
    } catch (error) {
      checks.push({
        id: "verifier-boundary",
        kind: "protected-files",
        passed: false,
        summary: error instanceof Error ? error.message : "Verifier boundary could not be verified",
        checkedAt: this.now().toISOString(),
        candidateCommit: commit,
      });
    }
    return this.supplementEvidence(state, item, record.cwd, commit, payload, checks);
  }

  private assertConfiguredCriteria(item: WorkItem, checks: EvidenceResult[], commit: string): void {
    if (this.options.independentChecks?.requireCriterionEvidence)
      assertCriterionEvidence(
        checks,
        item.acceptanceCriteria.map((criterion) => criterion.id),
        commit,
      );
  }

  private async supplementEvidence(
    state: TeamState,
    item: WorkItem | undefined,
    cwd: string,
    commit: string,
    payload: TeamReportPayload,
    checks: EvidenceResult[],
  ): Promise<EvidenceResult[]> {
    if (this.options.independentChecks)
      checks.push(...(await runIndependentChecks(cwd, commit, this.options.independentChecks)));
    try {
      assertBrowserEvidence(this.options.independentChecks, checks, commit);
    } catch (browserError) {
      checks.push({
        id: "browser-evidence-required",
        kind: "browser-artifact",
        passed: false,
        summary:
          browserError instanceof Error ? browserError.message : "Browser evidence unavailable",
        candidateCommit: commit,
        checkedAt: this.now().toISOString(),
      });
    }
    try {
      if (item) this.assertConfiguredCriteria(item, checks, commit);
    } catch (error) {
      checks.push({
        id: "criterion-evidence-required",
        kind: "command",
        passed: false,
        summary: error instanceof Error ? error.message : "Criterion evidence unavailable",
        candidateCommit: commit,
        checkedAt: this.now().toISOString(),
      });
    }
    if (state.team.policy?.requireOutcomeJudge) {
      if (this.options.decisionSource && checks.every((check) => check.passed)) {
        const judged = await this.options.decisionSource.judge({
          cwd: cwd,
          objective: state.team.objective,
          criteria: item?.acceptanceCriteria,
          candidateCommit: commit,
          checks,
          report: payload,
        });
        checks.push({
          id: "system-one-outcome",
          kind: "judge",
          passed: judged.verdict === "pass",
          summary: `${judged.source}/${judged.model}: ${judged.verdict}; ${judged.reason}; confidence ${judged.confidence}; latency ${judged.latencyMs}ms`,
          candidateCommit: commit,
          checkedAt: this.now().toISOString(),
        });
      }
      try {
        assertOutcomeJudged(state.team.policy, checks, commit);
      } catch (judgeError) {
        checks.push({
          id: "outcome-judge-required",
          kind: "judge",
          passed: false,
          summary: judgeError instanceof Error ? judgeError.message : "Outcome judge unavailable",
          candidateCommit: commit,
          checkedAt: this.now().toISOString(),
        });
      }
    }
    return checks;
  }

  private async recordWorkflowBaseline(state: TeamState, item: WorkItem, role: Role, cwd: string) {
    if (!state.team.workflowSnapshot || !role.canEdit || item.pack.workflowBaseCommit) return;
    const commit = await workflowHead(cwd);
    await this.store.commit(state.team.id, (draft) => {
      const target = draft.items[item.id];
      if (target && !target.pack.workflowBaseCommit) target.pack.workflowBaseCommit = commit;
      return { events: [], result: null };
    });
  }

  private async protectVerifier(
    state: TeamState,
    item: WorkItem,
    role: Role,
    agentId: string,
    cwd: string,
  ): Promise<void> {
    if (!this.pack(state.team).requireVerification || !this.needsProtectedVerification(state, role))
      return;
    const existing = item.pack.verifierProtection as
      | { agentId: string; revision: number }
      | undefined;
    if (existing?.agentId === agentId && existing.revision === item.revision) return;
    const snapshot = await (this.options.verificationSnapshot ?? captureTrackedFiles)(cwd);
    await this.store.commit(state.team.id, (draft) => {
      const target = draft.items[item.id];
      if (!target || target.revision !== item.revision)
        throw new Error("Verifier phase changed before protected snapshot was saved");
      target.pack.verifierProtection = { agentId, revision: item.revision, snapshot };
      return { events: [], result: null };
    });
  }

  async requestWork(agentId: string, input: WorkRequestInput): Promise<string> {
    const caller = await this.resolveCaller(agentId);
    if (!caller) throw new ReportRejectedError("This session is not seated in a team");
    return this.store.commit(caller.teamId, (draft) => {
      assertMutableTeam(draft.team);
      const events: TeamEventDraft[] = [];
      if (draft.team.kitchen?.workflowMode !== "self-organizing")
        throw new ReportRejectedError("Work requests require a self-organizing Kitchen");
      const child = expandWork(
        draft,
        this.policyPack(draft.team),
        draft.bindings[caller.binding.id]!,
        input,
        events,
      );
      return {
        events,
        result: `Recorded work item ${child.id}. Report needs with kind split or research, then wait for its verified result.`,
      };
    });
  }

  async plan(agentId: string, items: PlannedItem[]): Promise<string> {
    const caller = await this.resolveCaller(agentId);
    if (!caller) throw new ReportRejectedError("This session is not seated in a team");
    return this.store.commit(caller.teamId, (draft) => {
      assertMutableTeam(draft.team);
      const events: TeamEventDraft[] = [];
      const created = planItems(
        draft,
        this.pack(draft.team),
        draft.bindings[caller.binding.id]!,
        items,
        events,
      );
      return {
        events,
        result: `Recorded ${created.length} items. Now return a factory-report block with outcome "planned".`,
      };
    });
  }

  async onTurnEnded(
    teamId: string,
    agentId: string,
    errored: boolean,
    decisionId?: string,
    validationError?: string,
  ): Promise<void> {
    const before = await this.store.get(teamId);
    if (
      !before ||
      before.team.importedFrom?.readOnly ||
      ["done", "canceled"].includes(before.team.status)
    )
      return;
    const agent = await this.options.controller.get(agentId);
    await this.store.commit(teamId, async (draft) => {
      const events: TeamEventDraft[] = [];
      if (draft.team.status === "done" || draft.team.status === "canceled")
        return { events, result: null };
      if (await this.options.controller.isRunning(agentId)) return { events, result: null };
      const binding = findSeat(draft, agentId, decisionId);
      if (
        !binding ||
        (binding.turn !== "running" && !(binding.turn === "starting" && !binding.agentId))
      )
        return { events, result: null };
      const item = draft.items[binding.workItemId];
      if (!item) return { events, result: null };
      chargeBinding(draft, binding, this.now().getTime());
      binding.lastEventAt = this.now().toISOString();
      const reset = routingResetAt(agent, this.now().getTime());
      if (reset && binding.errors < MAX_ERROR_RETRIES) {
        binding.errors += 1;
        binding.turn = "idle";
        const retry = addDecision(
          draft,
          item,
          "message-role",
          { bindingId: binding.id, retry: true, routingResetAt: reset },
          `routing-reset:${binding.id}:${item.revision}:${reset}`,
        );
        retry.availableAt = reset;
        events.push({
          type: "health.routing-wait",
          actor: RUNTIME,
          workItemId: item.id,
          text: `${binding.role}: ${agent!.routingNotice!.reason}; retry after the host's reported reset ${reset}`,
          data: { routingNotice: agent!.routingNotice },
        });
      } else if (errored && binding.errors < MAX_ERROR_RETRIES) {
        binding.errors += 1;
        binding.turn = "idle";
        const decision = addDecision(
          draft,
          item,
          "message-role",
          { bindingId: binding.id, retry: true },
          `error-retry:${binding.id}:${item.revision}:${binding.errors}`,
        );
        const backoff = this.now().getTime() + Math.min(30, 2 ** binding.errors) * 60_000;
        decision.availableAt = new Date(backoff).toISOString();
        events.push({
          type: "health.provider-error",
          actor: RUNTIME,
          workItemId: item.id,
          text: `${binding.role} stopped with a provider error; retrying at ${decision.availableAt.slice(11, 16)} UTC`,
        });
      } else if (binding.nudges < 1) {
        binding.nudges += 1;
        binding.turn = "idle";
        addDecision(
          draft,
          item,
          "message-role",
          {
            bindingId: binding.id,
            nudge: true,
            errored,
            ...(validationError ? { validationError } : {}),
          },
          `nudge:${binding.id}:${item.revision}:${binding.nudges}`,
        );
        events.push({
          type: "health.report-missing",
          actor: RUNTIME,
          workItemId: item.id,
          text: `${binding.role} ended ${errored ? "with an error" : "its turn"} without a report; asking once more`,
        });
      } else {
        binding.turn = "idle";
        blockForBoss(
          draft,
          this.pack(draft.team),
          item,
          `${binding.role} stopped twice without a report`,
          events,
        );
      }
      return { events, result: null };
    });
    void this.dispatchAll();
  }

  dispatchAll(): Promise<void> {
    if (this.dispatchRun) {
      this.dispatchAgain = true;
      return this.dispatchRun;
    }
    this.dispatchRun = (async () => {
      do {
        this.dispatchAgain = false;
        await this.dispatchOnce();
      } while (this.dispatchAgain && !this.stopped);
    })().finally(() => {
      this.dispatchRun = null;
    });
    return this.dispatchRun;
  }

  private async dispatchOnce(): Promise<void> {
    try {
      for (const teamId of await this.store.listIds()) {
        const state = await this.store.get(teamId);
        if (!state) continue;
        if (state.team.status === "active" || state.team.status === "paused")
          await this.syncKitchenBoss(state.team);
        if (await this.updateRuntime(teamId)) {
          const latest = await this.store.get(teamId);
          if (latest) await this.syncKitchenBoss(latest.team);
          continue;
        }
        if (state.team.status !== "active" && state.team.status !== "done") continue;
        const now = this.now().getTime();
        const due = Object.values(state.decisions).filter(
          (d) =>
            (d.status === "pending" || d.status === "retry") &&
            Date.parse(d.availableAt) <= now &&
            (state.team.status === "active" || d.kind === "notify-human"),
        );
        for (const decision of due) {
          if (this.stopped) return;
          await this.runDecision(teamId, decision.id);
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, "Team dispatch failed");
    }
  }

  private async activeCookCount(): Promise<number> {
    const active = new Set<string>();
    for (const agent of await this.options.controller.list()) {
      if (agent.labels?.[TEAM_ROLE_LABEL] && (await this.options.controller.isRunning(agent.id)))
        active.add(agent.id);
    }
    for (const id of await this.store.listIds()) {
      const state = await this.store.get(id);
      if (!state) continue;
      for (const binding of Object.values(state.bindings)) {
        if (binding.activeStartedAt !== undefined)
          active.add(binding.agentId || binding.decisionId);
      }
    }
    return active.size;
  }

  private async safeConditionalDecision(
    state: TeamState | null,
    decision: TeamState["decisions"][string] | undefined,
  ) {
    try {
      return await this.skipConditionalDecision(state, decision);
    } catch (error) {
      if (!state || !decision) throw error;
      await this.store.commit(state.team.id, (draft) => {
        const item = draft.items[decision.workItemId];
        if (!item || item.phase !== decision.phase || draft.team.status !== "active")
          return { events: [], result: null };
        const events: TeamEventDraft[] = [];
        blockForBoss(
          draft,
          this.pack(draft.team),
          item,
          `Conditional workflow evidence unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
          events,
        );
        return { events, result: null };
      });
      return true;
    }
  }

  private async skipConditionalDecision(
    state: TeamState | null,
    decision: TeamState["decisions"][string] | undefined,
  ): Promise<boolean> {
    if (
      state?.team.workflowSnapshot &&
      decision &&
      ["start-role", "message-role"].includes(decision.kind)
    ) {
      const item = state.items[decision.workItemId];
      const phase = item ? boardOf(this.pack(state.team), item).phases[item.phase] : undefined;
      if (item && decision.phase === item.phase && phase?.condition && phase.skipTo) {
        const checkout = await this.itemWorktree(state, item);
        const observed = await observeChangedFiles(
          checkout,
          String(item.pack.workflowBaseCommit ?? ""),
          phase.condition,
        );
        const skipped = await this.store.commit(state.team.id, (draft) => {
          const target = draft.items[item.id];
          if (!target || target.revision !== item.revision || draft.team.status !== "active")
            return { events: [], result: true };
          target.pack.workflowCondition = observed;
          const events: TeamEventDraft[] = [
            {
              type: "workflow.condition-observed",
              actor: RUNTIME,
              workItemId: item.id,
              text: observed.matches
                ? "Changed files require the configured check"
                : "Observed changed files do not match the configured check",
              data: observed,
            },
          ];
          if (!observed.matches)
            enterPhase(
              draft,
              this.pack(draft.team),
              target,
              phase.skipTo!,
              RUNTIME,
              events,
              "observed changed-file condition did not match",
            );
          return { events, result: !observed.matches };
        });
        if (skipped) return true;
      }
    }
    return false;
  }

  private async runDecision(teamId: string, decisionId: string): Promise<void> {
    const state = await this.store.get(teamId);
    const decision = state?.decisions[decisionId];
    if (
      (decision?.kind === "start-role" || decision?.kind === "message-role") &&
      (await this.activeCookCount()) >= this.capacity()
    )
      return;
    if (await this.safeConditionalDecision(state, decision)) return;
    const leased = await this.store.commit(teamId, (draft) => {
      const d = draft.decisions[decisionId];
      if (
        draft.team.status !== "active" &&
        !(draft.team.status === "done" && d?.kind === "notify-human")
      )
        return { events: [], result: null };
      if (!d || (d.status !== "pending" && d.status !== "retry"))
        return { events: [], result: null };
      const item = draft.items[d.workItemId];
      if (!item || item.phase !== d.phase) {
        d.status = "superseded";
        return { events: [], result: null };
      }
      d.status = "leased";
      d.attempts += 1;
      d.leaseExpiresAt = new Date(this.now().getTime() + LEASE_MS).toISOString();
      return {
        events: [],
        result: { decision: structuredClone(d), state: structuredClone(draft) },
      };
    });
    if (!leased) return;

    try {
      const outcome = await this.execute(leased.state, leased.decision);
      await this.store.commit(teamId, (draft) => {
        const d = draft.decisions[decisionId]!;
        if (d.status !== "leased") return { events: [], result: null };
        d.status = "succeeded";
        d.leaseExpiresAt = undefined;
        const events = outcome(draft);
        events.push(...this.finishTeam(draft));
        return { events, result: null };
      });
      const current = (await this.store.get(teamId))!;
      if (
        current.team.status === "canceled" ||
        current.team.kitchen?.stopped ||
        current.team.runtime?.limitReason
      ) {
        await this.interruptTeam(teamId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, teamId, decisionId }, "Team decision failed");
      await this.store.commit(teamId, (draft) => {
        const d = draft.decisions[decisionId]!;
        for (const binding of Object.values(draft.bindings)) {
          if (binding.decisionId === decisionId || binding.id === d.payload.bindingId)
            chargeBinding(draft, binding, this.now().getTime());
        }
        if (d.status !== "leased") return { events: [], result: null };
        d.lastError = message;
        d.leaseExpiresAt = undefined;
        const events: TeamEventDraft[] = [];
        if (d.attempts >= MAX_ATTEMPTS) {
          d.status = "failed";
          const item = draft.items[d.workItemId];
          if (item)
            blockForBoss(
              draft,
              this.pack(draft.team),
              item,
              `${d.kind} failed: ${message}`,
              events,
            );
        } else {
          d.status = "retry";
          d.availableAt = new Date(
            this.now().getTime() + Math.min(60_000, 1000 * 2 ** d.attempts),
          ).toISOString();
        }
        return { events, result: null };
      });
    }
  }

  private recoverCompletion(state: TeamState): TeamEventDraft[] {
    const root = state.items[state.team.rootItemId];
    if (!root || !isTerminal(this.pack(state.team), root)) return [];
    addDecision(
      state,
      root,
      "notify-human",
      { text: summarizeTeam(state, this.pack(state.team)) },
      `done:${root.id}`,
    );
    return this.finishTeam(state);
  }

  private finishTeam(state: TeamState): TeamEventDraft[] {
    if (
      (state.team.kitchen && this.pack(state.team).requireVerification) ||
      state.team.status === "done" ||
      state.team.status === "canceled"
    )
      return [];
    const root = state.items[state.team.rootItemId];
    if (!root || !isTerminal(this.pack(state.team), root)) return [];
    const delivered = Object.values(state.decisions).some(
      (decision) =>
        decision.kind === "notify-human" &&
        decision.workItemId === root.id &&
        decision.idempotencyKey === `done:${root.id}` &&
        decision.status === "succeeded",
    );
    if (!delivered) return [];
    state.team.status = "done";
    state.team.pausedReason = undefined;
    return [{ type: "team.done", actor: RUNTIME, workItemId: root.id, text: "Team finished" }];
  }

  private async messageRole(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    decision: Decision,
  ): Promise<(draft: TeamState) => TeamEventDraft[]> {
    const binding = state.bindings[decision.payload.bindingId as string];
    if (!binding || binding.status !== "active") return () => [];
    const role = pack.roles[binding.role]!;
    let text = await this.workPacket(state, pack, item, role);
    if (typeof decision.payload.note === "string") {
      text = `The boss answered: ${decision.payload.note}\n\n${text}`;
    } else if (decision.payload.nudge) {
      const feedback =
        typeof decision.payload.validationError === "string"
          ? `\nValidation errors:\n${decision.payload.validationError.slice(0, 800)}`
          : "";
      text = `Your final factory-report JSON block was missing or rejected.${feedback}\nCorrect the report once, using the exact field types below. Do not repeat completed implementation work.\n\n${text}`;
    } else if (decision.payload.retry) {
      text = `Your last turn stopped with a provider error. Continue where you left off.\n\n${text}`;
    } else if (decision.payload.resume) {
      text = `The Paseo host restarted while you were working. Continue where you left off.\n\n${text}`;
    }
    const record = await this.validateRoleCheckout(state, pack, item, role, binding.agentId);
    if (role.canEdit && record) await this.integrateDependencies(state, pack, item, record.cwd);
    const allowed = await this.store.commit(state.team.id, (draft) => {
      const seat = draft.bindings[binding.id];
      if (
        draft.team.status !== "active" ||
        !seat ||
        seat.status !== "active" ||
        draft.decisions[decision.id]?.status !== "leased"
      )
        return { events: [], result: false };
      seat.activeStartedAt = this.now().toISOString();
      return { events: [], result: true };
    });
    if (!allowed) return () => [];
    await this.recordWorkflowBaseline(state, item, role, record!.cwd);
    await this.protectVerifier(state, item, role, binding.agentId, record!.cwd);
    await this.options.controller.send(binding.agentId, text);
    return (draft) => {
      const b = draft.bindings[binding.id];
      if (b?.status === "active") {
        b.turn = "running";
        b.lastEventAt = this.now().toISOString();
      }
      return decision.payload.nudge || decision.payload.resume
        ? []
        : [
            {
              type: "role.resumed",
              actor: { type: "role", id: binding.role },
              workItemId: item.id,
              text: `${role.title} picks up ${item.title} again`,
            },
          ];
    };
  }

  private async execute(
    state: TeamState,
    decision: Decision,
  ): Promise<(draft: TeamState) => TeamEventDraft[]> {
    const pack = this.pack(state.team);
    const item = state.items[decision.workItemId]!;
    assertMutableTeam(state.team);
    if (
      state.team.policy?.maxChainSteps !== undefined &&
      ["start-role", "message-role", "invoke-pack-action"].includes(decision.kind)
    )
      assertPolicyAllows(
        { maxChainSteps: state.team.policy.maxChainSteps },
        await this.policyObservation(state, decision.id),
      );
    switch (decision.kind) {
      case "start-role":
        return this.startRole(state, pack, item, decision);
      case "message-role":
        return this.messageRole(state, pack, item, decision);
      case "notify-human": {
        const text = String(decision.payload.text ?? "");
        await this.options.controller.send(
          state.team.bossAgentId,
          `<system-notification from="team ${state.team.id}">\n${text}\n\nTell the user in plain language. To answer a blocked Cook, use the Kitchen Teamchat so the plugin records the answer and resumes the work.\n</system-notification>`,
          "steer",
        );
        return () => [{ type: "boss.notified", actor: RUNTIME, workItemId: item.id, text }];
      }
      case "invoke-pack-action": {
        const action = pack.actions?.[String(decision.payload.action)];
        if (!action)
          throw new Error(`Pack ${pack.id} has no action ${String(decision.payload.action)}`);
        const input = action.input.parse(decision.payload.input);
        const output = await action.run(input);
        return () => [
          {
            type: "pack.action",
            actor: RUNTIME,
            workItemId: item.id,
            text: `${pack.id}.${String(decision.payload.action)} done`,
            data: output,
          },
        ];
      }
    }
  }

  private async startRole(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    decision: Decision,
  ): Promise<(draft: TeamState) => TeamEventDraft[]> {
    const roleId = String(decision.payload.role);
    const role = pack.roles[roleId];
    if (!role) throw new Error(`Pack ${pack.id} has no role ${roleId}`);
    const profile = this.executedRoleProfile(state, item, roleId);
    if (!profile) throw new Error(`No harness bound for role ${roleId}`);
    const profileName = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
    let agentId = await this.findAgentForDecision(decision.id);
    if (!agentId && state.team.policy)
      assertPolicyAllows(state.team.policy, await this.policyObservation(state, decision.id));

    const bindingId = await this.store.commit(state.team.id, (draft) => {
      const target = draft.items[item.id];
      const existing = Object.values(draft.bindings).find(
        (b) => b.decisionId === decision.id && b.status === "active",
      );
      if (draft.team.status !== "active" || draft.decisions[decision.id]?.status !== "leased")
        return { events: [], result: null };
      if (existing || !target) {
        if (existing) existing.activeStartedAt = this.now().toISOString();
        return { events: [], result: existing?.id ?? null };
      }
      const now = this.now().toISOString();
      const previous = activeBinding(draft, target, roleId);
      if (previous) {
        previous.status = "revoked";
        previous.revokedAt = now;
      }
      const binding: Binding = {
        id: newId("seat"),
        workItemId: item.id,
        role: roleId,
        phase: target.phase,
        revisionAtStart: target.revision,
        decisionId: decision.id,
        agentId: "",
        profile: profileName,
        executedProfile: structuredClone(profile),
        status: "active",
        turn: "starting",
        nudges: 0,
        errors: 0,
        lastEventAt: now,
        createdAt: now,
        activeStartedAt: now,
        activeMs: 0,
      };
      draft.bindings[binding.id] = binding;
      target.bindings[roleId] = binding.id;
      return { events: [], result: binding.id };
    });
    if (!bindingId) return () => [];

    if (!agentId) {
      if (this.options.controller.validateProvider)
        await this.options.controller.validateProvider({ ...profile, cwd: state.team.cwd });
      const key = String(item.pack.key ?? item.id)
        .replace(/[^A-Za-z0-9-]/g, "-")
        .toLowerCase();
      const cwd =
        role.workspace === "item-worktree" ? await this.itemWorktree(state, item) : state.team.cwd;
      const created = await this.options.controller.create({
        provider: profileName,
        title: `${role.title} · ${item.title}`,
        cwd,
        thinking: profile.thinking,
        mode: profile.mode,
        labels: {
          [TEAM_LABEL]: state.team.id,
          [TEAM_ROLE_LABEL]: roleId,
          [TEAM_ITEM_LABEL]: item.id,
          [TEAM_DECISION_LABEL]: decision.id,
          [TEAM_TOOLS_LABEL]: role.tools.join(","),
        },
        ...(role.workspace === "own-worktree"
          ? {
              worktree: {
                worktreeName: `team-${state.team.id.slice(-6)}-${key}`,
                branchName: `team/${state.team.id.slice(-6)}/${key}`,
                baseBranch: state.team.baseBranch ?? "main",
              },
            }
          : {}),
        parentAgentId: state.team.bossAgentId,
        decisionId: decision.id,
      });
      agentId = created.id;
    }
    const record = await this.validateRoleCheckout(state, pack, item, role, agentId);
    if (!(await this.options.controller.isRunning(agentId))) {
      if (role.canEdit && record) await this.integrateDependencies(state, pack, item, record.cwd);
      const latest = await this.store.get(state.team.id);
      if (latest?.team.status !== "active" || latest.decisions[decision.id]?.status !== "leased")
        return () => [];
      await this.recordWorkflowBaseline(state, item, role, record!.cwd);
      await this.protectVerifier(state, item, role, agentId, record!.cwd);
      await this.options.controller.send(agentId, await this.workPacket(state, pack, item, role));
    }
    const finalAgentId = agentId;
    return (draft) => {
      const binding = draft.bindings[bindingId];
      if (!binding || binding.status !== "active") return [];
      binding.agentId = finalAgentId;

      if (binding.turn === "starting") binding.turn = "running";
      return [
        {
          type: "role.started",
          actor: { type: "role", id: roleId },
          workItemId: item.id,
          text: `${role.title} takes ${item.title} (${profileName})`,
          data: { agentId: finalAgentId, bindingId },
        },
      ];
    };
  }

  private async validateRoleCheckout(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    role: Role,
    agentId: string,
  ): Promise<FactoryAgent | null> {
    const record = await this.options.controller.get(agentId);
    if (!pack.requireVerification) return record;
    if (!record) throw new Error(`Kitchen checkout unavailable for ${role.title} (${agentId})`);
    const actual = await realpath(record.cwd);
    const source = await realpath(state.team.cwd);
    const expected =
      role.workspace === "item-worktree"
        ? await realpath(await this.itemWorktree(state, item))
        : source;
    if (
      (role.workspace === "own-worktree" && actual === source) ||
      (role.workspace === "item-worktree" && (actual !== expected || actual === source)) ||
      (role.workspace === "team" && actual !== expected)
    )
      throw new Error(
        `Kitchen checkout mismatch for ${role.title} (${agentId}): actual ${actual}; expected ${role.workspace === "own-worktree" ? `an independent worktree outside ${source}` : expected}. No work prompt was sent. Repair the worker workspace before retrying.`,
      );
    return record;
  }

  private async findAgentForDecision(decisionId: string): Promise<string | undefined> {
    const existing = (await this.options.controller.list()).find(
      (r) => r.labels?.[TEAM_DECISION_LABEL] === decisionId && !r.archivedAt,
    );
    return existing?.id;
  }

  private async integrateDependencies(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    cwd: string,
  ): Promise<void> {
    if (!pack.requireVerification) return;
    const dependencies =
      item.board === "root"
        ? Object.values(state.items)
            .filter((candidate) => candidate.parentId === item.id)
            .map((candidate) => ({ id: candidate.id }))
        : item.dependsOn;
    for (const dependency of dependencies) {
      const previous = state.items[dependency.id];
      const commit = previous?.pack.verifiedCommit;
      if (typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit))
        throw new Error(`Dependency ${dependency.id} has no verified commit`);
      try {
        await execFileAsync("git", ["-C", cwd, "merge", "--no-edit", commit]);
      } catch (error) {
        const conflicts = await execFileAsync("git", ["-C", cwd, "ls-files", "--unmerged"]);
        if (!conflicts.stdout.trim()) throw error;
        return;
      }
    }
  }

  private async itemWorktree(state: TeamState, item: WorkItem): Promise<string> {
    const role = item.board === "root" ? "integrator" : "developer";
    const binding = state.bindings[item.bindings[role] ?? ""];
    const agentId =
      binding?.agentId ||
      (binding ? await this.findAgentForDecision(binding.decisionId) : undefined);
    const record = agentId ? await this.options.controller.get(agentId) : null;
    if (state.team.kitchen && this.pack(state.team).requireVerification) {
      if (!record || record.cwd === state.team.cwd)
        throw new Error(
          "Kitchen product checkout is unavailable; refusing to use the source project",
        );
      return record.cwd;
    }
    return record?.cwd ?? state.team.cwd;
  }

  private async workPacket(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    role: Role,
  ): Promise<string> {
    const phase = boardOf(pack, item).phases[item.phase]!;
    const outcomes = Object.keys(phase.outcomes ?? {}).join(", ");
    const lines: string[] = [
      `# ${role.title}: ${item.title}`,
      "",
      role.instructions,
      "",
      `## Team goal`,
      state.team.objective,
    ];
    if (state.team.kitchen?.spec)
      lines.push("", "## Mission specification", state.team.kitchen.spec);
    appendMissionGoal(state.team, lines);
    this.appendRoleWorkflow(state, item, role.id, lines);
    if (item.board === "item") lines.push("", "## This work item", item.objective);
    if (item.acceptanceCriteria.length) {
      lines.push(
        "",
        "## Acceptance criteria",
        ...item.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text}`),
      );
    }
    if (item.board === "item") {
      const deps = item.dependsOn
        .map((d) => state.items[d.id])
        .filter((d): d is WorkItem => Boolean(d))
        .map(
          (d) =>
            `- [${d.id}] ${d.title}: ${d.reports.at(-1)?.summary ?? d.phase}, verified commit ${String(d.pack.verifiedCommit ?? "unavailable")}`,
        );
      if (deps.length) lines.push("", "## Finished dependencies", ...deps);
    }
    if (item.reports.length) {
      lines.push(
        "",
        "## History of this item",
        ...item.reports.map((r) => `- ${r.role} (${r.phase}) → ${r.outcome}: ${r.summary}`),
      );
    }
    if (item.artifacts.length) {
      lines.push(
        "",
        "## Artifacts",
        ...item.artifacts.map((a) => `- ${a.kind}: ${a.ref}${a.note ? ` (${a.note})` : ""}`),
      );
    }
    await this.appendKitchenContext(state, pack, item, role, lines);
    const skills = [
      ...new Set([
        ...role.skills,
        ...(this.executedRoleProfile(state, item, role.id)?.skills ?? []),
      ]),
    ];
    if (skills.length)
      lines.push(
        "",
        "## Skills to use",
        skills.join(", "),
        "Resolve these names through your harness's installed skills and read their instructions before applying them. If a required skill is missing, report the concrete missing skill as a human need; do not invent a tool or claim the skill ran.",
      );
    if (role.evidence && item.board === "item") {
      const file = await this.writeEvidence(state, item);
      lines.push(
        "",
        "## Review inputs",
        `- Evidence file: ${file}`,
        `- Base branch: ${state.team.baseBranch ?? "main"}`,
      );
    }
    lines.push(
      "",
      "## Rules",
      `- Allowed outcomes for the report: ${outcomes}.`,
      "- End your final assistant response with one fenced JSON block labelled factory-report.",
      "- Required report fields: outcome (one allowed string), summary (nonempty string). Optional fields: artifacts, criteria, needs.",
      '- artifacts is an array of objects {"kind":"commit","ref":"commit hash or evidence location","note":"optional description"}. kind must be branch, commit, pr, screenshot, test-run, document or other. Never use artifact strings.',
      '- criteria is an array of objects {"id":"exact acceptance criterion ID above","met":true,"evidence":"concrete check and result"}. id and evidence are strings; met is a boolean. Never use criterion strings or a field named criterion.',
      "- Omit optional artifacts and criteria when there is no concrete evidence. The PO plans future acceptanceCriteria; it must omit report.criteria and report.artifacts unless it actually collected concrete evidence.",
      '- Optional needs shape: {"kind":"human","text":"the decision needed"}; kind must be human, research or split. Use head-chef only when the configured communication route below explicitly allows it.',
      "- Omit items unless you are the planning role. PO items are objects with key, title, objective (nonempty strings), acceptanceCriteria (nonempty array of strings), optional dependsOn and conflictsWith (arrays of item key strings), optional exclusive (boolean).",
      ...(role.tools.includes("item_plan")
        ? [
            '- PO example: {"report":{"outcome":"planned","summary":"One implementable item"},"items":[{"key":"A","title":"Implement feature","objective":"Deliver the requested behavior","acceptanceCriteria":["Expected behavior is verified"],"dependsOn":[],"conflictsWith":[]}]}',
          ]
        : [
            `- Worker example using this item's IDs: ${JSON.stringify({ report: reportExample(pack, item, role, Object.keys(phase.outcomes ?? {})[0]) })}. Replace example evidence with actual evidence.`,
          ]),
      "- Do not call team_report or item_plan tools; this plugin reads your final factory-report block.",
      role.canEdit
        ? "- You may change code in this workspace. Resolve any existing merge conflicts and integrate every verified dependency commit listed above before finishing."
        : "- Do not change any files.",
      "- You cannot start other agents. Everything you hand on goes through your final factory-report block.",
    );
    lines.push(...workflowCommunication(state, role));
    return lines.join("\n");
  }

  private async appendKitchenContext(
    state: TeamState,
    pack: WorkflowPack,
    item: WorkItem,
    role: Role,
    lines: string[],
  ): Promise<void> {
    if (pack.requireVerification && role.id === "verifier")
      lines.push(
        "",
        "## Required verification report",
        'A pass requires exactly one commit artifact {kind:"commit",ref:"full physical git HEAD"}, a clean git status, and criteria [{id,met:true,evidence}] for EVERY criterion listed above. Runtime rechecks HEAD and clean status; do not guess or omit evidence.',
      );
    if (pack.requireVerification && role.id === "integrator")
      lines.push(
        "",
        "## Required integration report",
        'A done report requires exactly one commit artifact {kind:"commit",ref:"full final git HEAD"}.',
      );
    if (item.board === "root" && pack.requireVerification)
      appendVerifiedChildren(state, item, lines);
    if (pack.id === "kitchen-insights" || pack.id === "kitchen-gardener")
      lines.push(
        "",
        "## Measured Kitchen sample",
        JSON.stringify(await this.kitchenSample(state.team.cwd), null, 2),
      );
    if (
      state.team.kitchen?.workflowMode === "self-organizing" &&
      role.tools.includes("item_request_work")
    )
      lines.push(
        "",
        "## Additional work",
        'Use optional workRequests array beside report. Each request has requestId (stable nonempty string), title, objective, acceptanceCriteria (nonempty string array), optional parentId and dependsOn/conflictsWith item IDs. Report needs:{kind:"split",text:"why"} or needs:{kind:"research",text:"why"} and wait for verified children. Reuse each request identity on retry; include only work needed for this item and the declared team goal. The runtime dispatches verified dependencies automatically and enforces explicitly selected delegation limits.',
      );
  }

  private async kitchenSample(cwd: string): Promise<Record<string, unknown>> {
    const teams: TeamState[] = [];
    for (const id of await this.store.listIds()) {
      const state = await this.store.get(id);
      if (state?.team.cwd === cwd) teams.push(state);
    }
    const recent = teams
      .sort((left, right) => right.team.createdAt.localeCompare(left.team.createdAt))
      .slice(0, 20);
    const samples = await Promise.all(
      recent.map(async (state) => {
        const events = await this.store.events(state.team.id);
        const items = Object.values(state.items);
        return {
          teamId: state.team.id,
          createdAt: state.team.createdAt,
          commit: state.commit,
          packId: state.team.packId,
          status: state.team.status,
          items: items.length,
          blockedItems: items.filter((item) => item.phase === "blocked").length,
          returns: items.reduce((total, item) => total + item.returns, 0),
          reports: items.reduce((total, item) => total + item.reports.length, 0),
          artifacts: items.reduce((total, item) => total + item.artifacts.length, 0),
          runtime: state.team.runtime,
          eventCounts: events.reduce<Record<string, number>>((counts, event) => {
            counts[event.type] = (counts[event.type] ?? 0) + 1;
            return counts;
          }, {}),
          recentLogbook: events.slice(-20).map((event) => ({
            at: event.at,
            commit: event.commit,
            type: event.type,
            workItemId: event.workItemId,
            actorType: event.actor.type,
          })),
        };
      }),
    );
    return {
      measuredAt: this.now().toISOString(),
      cwd,
      sampledTeams: recent.length,
      matchingTeams: teams.length,
      sampleLimit: 20,
      teams: samples,
    };
  }

  private async writeEvidence(state: TeamState, item: WorkItem): Promise<string> {
    const dir = join(this.options.storageRoot, "teams", state.team.id, "evidence");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${item.id}.md`);
    const body = [
      `# ${item.title}`,
      "",
      "## Team goal",
      state.team.objective,
      "",
      "## Work item",
      item.objective,
      "",
      "## Acceptance criteria",
      ...item.acceptanceCriteria.map((c) => `- [${c.id}] ${c.text}`),
      "",
      "## History",
      ...item.reports.map((r) => `- ${r.role} (${r.phase}) → ${r.outcome}: ${r.summary}`),
      "",
    ].join("\n");
    await writeFile(file, body);
    return file;
  }

  private async updateRuntime(teamId: string): Promise<boolean> {
    const before = await this.store.get(teamId);
    if (!before || before.team.status === "done" || before.team.status === "canceled") return false;
    const agents = (await this.options.controller.list()).filter(
      (agent) => agent.labels?.[TEAM_LABEL] === teamId && agent.labels?.[TEAM_ROLE_LABEL],
    );
    const observed = agents.filter((agent) => agent.usageTotals !== undefined);
    const policy = before.team.policy
      ? evaluatePolicy(before.team.policy, await this.policyObservation(before))
      : [];
    const limit = await this.store.commit(teamId, (draft) => {
      if (draft.team.status === "done" || draft.team.status === "canceled")
        return { events: [], result: false };
      const runtime = (draft.team.runtime ??= runtimeState(draft.team.policy, this.capacity()));
      runtime.limits = runtimeState(draft.team.policy, this.capacity()).limits;
      for (const binding of Object.values(draft.bindings))
        chargeBinding(draft, binding, this.now().getTime(), true);
      runtime.usage.tokensAvailable = agents.length > 0 && observed.length === agents.length;
      if (observed.length)
        runtime.usage.observedTokens = observed.reduce(
          (total, agent) =>
            total + agent.usageTotals!.inputTokens + agent.usageTotals!.outputTokens,
          0,
        );
      const livePolicy = draft.team.policy
        ? evaluatePolicy(draft.team.policy, {
            activeMs: runtime.usage.activeMs,
            roleActiveMs: runtime.usage.roleActiveMs,
          }).filter(
            (failure) =>
              failure.dimension === "totalActiveMs" || failure.dimension === "roleActiveMs",
          )
        : [];
      const reason =
        [...policy, ...livePolicy].find(
          (failure) =>
            failure.dimension !== "maxAgentStarts" &&
            failure.dimension !== "maxDelegationDepth" &&
            failure.dimension !== "maxChainSteps",
        )?.message ?? runtimeLimitReason(draft);
      if (!reason) return { events: [], result: false };
      if (runtime.limitReason) return { events: [], result: true };
      runtime.limitReason = reason;
      draft.team.status = "paused";
      draft.team.pausedReason = reason;
      if (draft.team.kitchen) draft.team.kitchen.stopped = true;
      for (const decision of Object.values(draft.decisions)) {
        if (["pending", "retry", "leased", "proposed"].includes(decision.status)) {
          decision.status = "superseded";
          decision.leaseExpiresAt = undefined;
        }
      }
      for (const binding of Object.values(draft.bindings)) {
        chargeBinding(draft, binding, this.now().getTime());
        if (binding.status === "active") {
          binding.status = "revoked";
          binding.revokedAt = this.now().toISOString();
        }
      }
      return {
        events: [{ type: "safety.limit-reached", actor: RUNTIME, text: reason }],
        result: true,
      };
    });
    if (
      limit &&
      (!before?.team.runtime?.limitReason ||
        (
          await Promise.all(agents.map((agent) => this.options.controller.isRunning(agent.id)))
        ).some(Boolean))
    )
      await this.interruptTeam(teamId);
    if (limit) {
      const latest = await this.store.get(teamId);
      if (latest) await this.syncKitchenBoss(latest.team);
    }
    return limit;
  }

  async healthAll(): Promise<void> {
    for (const teamId of await this.store.listIds()) {
      const state = await this.store.get(teamId);
      if (!state) continue;
      if (await this.updateRuntime(teamId)) continue;
      if (state.team.status !== "active") continue;
      const now = this.now().getTime();
      await this.store.commit(teamId, async (draft) => {
        const events: TeamEventDraft[] = [];
        const pack = this.pack(draft.team);
        for (const d of Object.values(draft.decisions)) {
          if (d.status === "leased" && d.leaseExpiresAt && Date.parse(d.leaseExpiresAt) < now) {
            d.status = "retry";
            d.leaseExpiresAt = undefined;
            events.push({
              type: "health.decision-stuck",
              actor: RUNTIME,
              workItemId: d.workItemId,
              text: `Retrying ${d.kind}`,
            });
          }
        }
        for (const item of Object.values(draft.items)) {
          const phase = boardOf(pack, item).phases[item.phase]!;
          if (phase.kind !== "working" || !phase.role) continue;
          const binding = activeBinding(draft, item, phase.role);
          const inFlight = Object.values(draft.decisions).some(
            (d) =>
              d.workItemId === item.id &&
              ["pending", "leased", "retry", "proposed"].includes(d.status),
          );
          if (!binding && !inFlight) {
            addDecision(
              draft,
              item,
              "start-role",
              { role: phase.role, revision: item.revision },
              `seat-missing:${item.id}:${item.revision}`,
            );
            events.push({
              type: "health.seat-missing",
              actor: RUNTIME,
              workItemId: item.id,
              text: `No ${phase.role} on ${item.title}; starting one`,
            });
          }
          if (
            binding &&
            binding.turn === "running" &&
            now - Date.parse(binding.lastEventAt) > NO_PROGRESS_MS
          ) {
            const agent = await this.options.controller.get(binding.agentId);
            const lastActivity = agent?.updatedAt ? new Date(agent.updatedAt).getTime() : 0;
            if (now - lastActivity > NO_PROGRESS_MS) {
              binding.lastEventAt = new Date(now).toISOString();
              addDecision(
                draft,
                item,
                "notify-human",
                {
                  text: `${item.title}: the ${binding.role} has shown no progress for 45 minutes.`,
                },
                `no-progress:${binding.id}:${Math.floor(now / NO_PROGRESS_MS)}`,
              );
            }
          }
        }
        schedule(draft, pack, events);
        return { events, result: null };
      });
    }
    void this.dispatchAll();
  }
}

function reportExample(
  pack: WorkflowPack,
  item: WorkItem,
  role: Role,
  outcome: string | undefined,
): Record<string, unknown> {
  const commitRequired =
    pack.requireVerification &&
    (role.id === "verifier" ||
      role.id === "integrator" ||
      Object.values(pack.boards.item.phases).some(
        (phase) => phase.role === role.id && phase.condition,
      ));
  const criteria =
    role.id === "verifier" ? item.acceptanceCriteria : item.acceptanceCriteria.slice(0, 1);
  return {
    outcome,
    summary: "Observed result",
    artifacts: commitRequired
      ? [{ kind: "commit", ref: "full physical git HEAD" }]
      : [{ kind: "test-run", ref: "a real test log path" }],
    ...(criteria.length
      ? {
          criteria: criteria.map((criterion) => ({
            id: criterion.id,
            met: true,
            evidence: "actual check and result",
          })),
        }
      : {}),
  };
}

function bossProfile(boss: FactoryAgent): Team["roleProfiles"][string] {
  return {
    provider: boss.provider,
    model: boss.runtimeInfo?.model ?? boss.model ?? undefined,
    mode: boss.currentModeId ?? boss.runtimeInfo?.modeId ?? undefined,
    thinking: boss.thinkingOptionId ?? boss.runtimeInfo?.thinkingOptionId ?? undefined,
  };
}

function findSeat(state: TeamState, agentId: string, decisionId?: string): Binding | undefined {
  return Object.values(state.bindings).find(
    (b) =>
      b.status === "active" &&
      (b.agentId === agentId || (decisionId !== undefined && b.decisionId === decisionId)),
  );
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

const ProjectProfileSchema = z
  .object({
    workflowPack: z.string().min(1).optional(),
    roles: z.record(z.string(), RoleProfileOverrideSchema).optional(),
  })
  .passthrough();

export async function readProjectProfile(
  cwd: string,
): Promise<z.infer<typeof ProjectProfileSchema>> {
  let text: string;
  try {
    text = await readFile(join(cwd, ".agent-factory", "project.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      text = await readFile(join(cwd, ".pandaos", "project.json"), "utf8");
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw legacyError;
    }
  }
  return ProjectProfileSchema.parse(JSON.parse(text));
}

function runtimeState(
  policy?: Team["policy"],
  capacity = resolveAgentCapacity(),
): NonNullable<Team["runtime"]> {
  return {
    limits: {
      maxActiveCooks: capacity,
      roleActiveMs: policy?.roleActiveMs,
      totalActiveMs: policy?.totalActiveMs,
      observedTokens: policy?.maxTokens,
    },
    usage: { activeMs: 0, roleActiveMs: {}, tokensAvailable: false },
  };
}

function chargeBinding(state: TeamState, binding: Binding, now: number, continuing = false): void {
  if (!binding.activeStartedAt) return;
  const elapsed = Math.max(0, now - Date.parse(binding.activeStartedAt));
  const runtime = (state.team.runtime ??= runtimeState(state.team.policy));
  binding.activeMs = (binding.activeMs ?? 0) + elapsed;
  runtime.usage.activeMs += elapsed;
  runtime.usage.roleActiveMs[binding.role] =
    (runtime.usage.roleActiveMs[binding.role] ?? 0) + elapsed;
  binding.activeStartedAt = continuing ? new Date(now).toISOString() : undefined;
}

function requestFingerprint(input: StartKitchenInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: input.title,
        objective: input.objective,
        cwd: input.cwd,
        provider: input.provider,
        model: input.model,
        mode: input.mode,
        thinking: input.thinking,
        packId: input.packId,
        workflowId: input.workflowId,
        acceptanceCriteria: input.acceptanceCriteria,
        workflowMode: input.workflowMode ?? "fixed",
        missionMode: input.missionMode,
        scheduleId: input.scheduleId,
        kind: input.kind ?? "feature",
        sourceAgentId: input.sourceAgentId,
        workspaceId: input.workspaceId,
        roleProfiles: input.roleProfiles,
        policy: input.policy,
        executionMode: input.executionMode,
        spec: input.spec,
        publication: input.publication,
      }),
    )
    .digest("hex");
}

function validateKitchenInput(params: StartKitchenInput): void {
  if (
    params.missionMode &&
    params.workflowMode &&
    params.workflowMode !== (params.missionMode === "goal-driven" ? "self-organizing" : "fixed")
  )
    throw new Error("Mission mode and workflow mode must agree");
  for (const [field, value] of Object.entries({
    title: params.title,
    objective: params.objective,
    cwd: params.cwd,
    provider: params.provider,
    idempotencyKey: params.idempotencyKey,
  })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  }
}

async function gitRepository(cwd: string): Promise<string> {
  const result = await execFileAsync("git", [
    "-C",
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return result.stdout.trim();
}

function acceptanceCandidate(state: TeamState): { root: WorkItem; commit: string } {
  const root = state.items[state.team.rootItemId];
  const commit = root?.pack.verifiedCommit;
  const report = root?.reports.at(-1);
  if (
    !state.team.kitchen ||
    state.team.status === "canceled" ||
    root?.phase !== "ready-for-human" ||
    typeof commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) ||
    report?.role !== "verifier" ||
    report.outcome !== "pass"
  )
    throw new Error(
      "Kitchen acceptance requires the final verified candidate ready for human review",
    );
  return { root, commit };
}

function appendMissionGoal(team: Team, lines: string[]): void {
  if (team.kitchen?.missionMode === "goal-driven")
    lines.push(
      "",
      "## Goal-driven mission",
      "Keep working toward the declared team goal and every acceptance criterion. Plan the next dependent features without waiting for a separate kickoff. Discover and request missing implementation or research within this goal through stable workRequests when your role permits it; never invent unrelated scope or create a second team. A finished work item is not a finished mission. Existing dependency scheduling continues automatically through review, independent verification and combined integration. Stop only when the verified goal is ready for operator acceptance, an explicit limit is reached, the operator stops the mission, or a genuine human decision is needed.",
      'For a genuine scope, product, permission or missing-information decision, report needs:{kind:"human",text:"the precise question and options"}. This persists the question and blocks that item; the operator answer resumes it. Never guess an answer, approve your own result, publish, merge or deploy.',
    );
}

function clearLegacyRuntimeLimit(team: Team): string | undefined {
  const reason = team.runtime?.limitReason;
  if (!reason) return undefined;
  const removed =
    (/^.+ reached 60 minutes active time$/.test(reason) &&
      team.policy?.roleActiveMs === undefined) ||
    (reason === "Team reached four hours aggregate active time" &&
      team.policy?.totalActiveMs === undefined) ||
    (reason === "Team reached 500,000 observed tokens" && team.policy?.maxTokens === undefined);
  if (!removed) return undefined;
  team.runtime!.limitReason = undefined;
  team.runtime!.limits = runtimeState(team.policy, team.runtime!.limits.maxActiveCooks).limits;
  if (team.pausedReason === reason)
    team.pausedReason = "Previous default budget removed; resume to continue";
  return `Removed previous automatic limit: ${reason}`;
}

function runtimeLimitReason(state: TeamState): string | undefined {
  return state.team.runtime?.limitReason;
}

function selectedLimit(pack: number | undefined, policy: number | undefined): number | undefined {
  if (pack === undefined) return policy;
  if (policy === undefined) return pack;
  return Math.min(pack, policy);
}

function kitchenMissionMode(input: StartKitchenInput): "goal-driven" | "planned" {
  return input.missionMode ?? (input.workflowMode === "fixed" ? "planned" : "goal-driven");
}

function kitchenWorkflowMode(input: StartKitchenInput): "fixed" | "self-organizing" {
  return (
    input.workflowMode ??
    (kitchenMissionMode(input) === "goal-driven" ? "self-organizing" : "fixed")
  );
}

function appendVerifiedChildren(state: TeamState, item: WorkItem, lines: string[]): void {
  const children = Object.values(state.items).filter((candidate) => candidate.parentId === item.id);
  if (children.length) lines.push("", "## Verified child results");
  for (const child of children) {
    lines.push(
      `- [${child.id}] ${child.title}: ${child.phase}, verified commit ${String(child.pack.verifiedCommit ?? "not verified")}`,
    );
    for (const criterion of child.acceptanceCriteria)
      lines.push(
        `  - [${criterion.id}] ${criterion.text}: ${criterion.met ? "met" : "not confirmed"}${criterion.evidence ? `; ${criterion.evidence}` : ""}`,
      );
    for (const artifact of child.artifacts) lines.push(`  - ${artifact.kind}: ${artifact.ref}`);
  }
}

function routingResetAt(agent: FactoryAgent | null, now: number): string | undefined {
  const notice = agent?.routingNotice;
  if (!notice || !["waiting", "exhausted", "retrying"].includes(notice.status) || !notice.resetsAt)
    return undefined;
  const reset = Date.parse(notice.resetsAt);
  if (!Number.isFinite(reset) || reset <= now) return undefined;
  return new Date(reset + 1_000).toISOString();
}

function assertMutableTeam(team: Team): void {
  if (team.importedFrom?.readOnly)
    throw new Error(
      "Imported native jobs are read-only; they cannot be resumed or changed by this plugin",
    );
}

function assertBrowserEvidence(
  options: IndependentCheckOptions | undefined,
  checks: EvidenceResult[],
  commit: string,
): void {
  if (
    options?.requireBrowserEvidence &&
    !checks.some(
      (check) =>
        check.kind === "browser-artifact" && check.passed && check.candidateCommit === commit,
    )
  )
    throw new Error("Configured browser evidence is required for the current verified candidate");
}

function workflowCommunication(state: TeamState, role: Role): string[] {
  const lines: string[] = [];
  lines.push(
    "",
    "## Communication routes",
    JSON.stringify(
      state.team.workflowSnapshot?.autonomy ?? {
        architecture: "human",
        requirements: "human",
        irreversibleActions: "human",
        finalAcceptance: "human",
      },
    ),
    JSON.stringify(
      (role as WorkflowDefinition["roles"][string]).communication ?? {
        clarification: "human",
        investigation: "human",
      },
    ),
    "Clarification to head-chef uses report.needs.kind=head-chef; human decisions use human. Additional work must use actual workRequests and the declared work-request tool route. Host tool access remains controlled by the host/provider.",
  );
  return lines;
}

function workflowExecutionMode(
  definition: WorkflowDefinition | undefined,
  pack: WorkflowPack,
): "single" | "team" {
  return definition?.basePackId === "kitchen-single" || pack.id === "kitchen-single"
    ? "single"
    : "team";
}

function mergeWorkflowProfiles(
  base: Record<string, RoleProfileOverride> | undefined,
  overrides: Record<string, RoleProfileOverride> | undefined,
): Record<string, RoleProfileOverride> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base ?? {}), ...Object.keys(overrides ?? {})])].map((id) => [
      id,
      { ...base?.[id], ...overrides?.[id] },
    ]),
  );
}
