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
const LIMITS = {
  maxActiveCooks: 4,
  roleActiveMs: 60 * 60_000,
  totalActiveMs: 4 * 60 * 60_000,
  observedTokens: 500_000,
};

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
  private readonly logger: FactoryLogger;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private dispatchRun: Promise<void> | null = null;
  private dispatchAgain = false;
  private readonly now: () => Date;
  private readonly kitchenStarts = new Map<string, Promise<TeamState>>();
  private kitchenStartChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TeamServiceOptions) {
    this.store = new TeamStore(join(options.storageRoot, "teams"));
    this.logger = options.logger.child({ module: "team" });
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
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
  private limitPack(pack: WorkflowPack): WorkflowPack {
    const limit = this.options.maxConcurrentAgents?.() ?? pack.maxParallel;
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Factory concurrency must be positive");
    return { ...pack, maxParallel: Math.min(pack.maxParallel, limit) };
  }
  private pack(team: Team): WorkflowPack {
    const pack = this.options.packs.get(team.packId);
    if (!pack) throw new Error(`Workflow pack ${team.packId} is not installed`);
    return this.limitPack(pack);
  }

  private async recoverTeam(teamId: string): Promise<void> {
    const state = await this.store.get(teamId);
    if (!state) return;
    if (state.team.status === "done" || state.team.status === "canceled") return;
    await this.syncKitchenBoss(state.team);
    const pack = this.options.packs.get(state.team.packId);
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
      await this.verifyReportCheckout(
        binding.agentId,
        draft,
        this.pack(draft.team).roles[binding.role],
        completion.report,
      );
      if (
        completion.items &&
        !Object.values(draft.items).some((child) => child.parentId === item.id)
      )
        planItems(draft, this.pack(draft.team), binding, completion.items, events);
      if (completion.workRequests?.length) {
        if (draft.team.kitchen?.workflowMode !== "self-organizing")
          throw new ReportRejectedError("Work requests require a self-organizing Kitchen");
        for (const request of completion.workRequests)
          expandWork(draft, this.pack(draft.team), binding, request, events);
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
  }): Promise<TeamState> {
    const boss = await this.options.controller.get(params.bossAgentId);
    if (!boss) throw new Error(`Boss agent ${params.bossAgentId} not found`);
    if (boss.labels?.[TEAM_ROLE_LABEL]) throw new Error("Team members cannot start teams");
    const cwd = params.cwd ?? boss.cwd;
    const profile = await readProjectProfile(cwd);
    const resolved = await this.options.packs.resolveFor(
      cwd,
      params.packId ?? profile.workflowPack,
    );
    const pack = resolved ? this.limitPack(resolved) : undefined;
    if (!pack)
      throw new Error(`Workflow pack ${params.packId ?? profile.workflowPack} is not installed`);
    const defaultProfile = bossProfile(boss);
    const roleProfiles: Team["roleProfiles"] = {};
    for (const role of Object.keys(pack.roles)) {
      roleProfiles[role] =
        profile.roles?.[role] ?? this.options.roleProfiles?.()[role] ?? defaultProfile;
    }
    const { state, events } = createTeamState({
      pack,
      title: params.title,
      objective: params.objective,
      cwd,
      baseBranch: await currentBranch(cwd),
      bossAgentId: params.bossAgentId,
      roleProfiles,
    });
    state.team.runtime = runtimeState();
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
    const { cwd, pack, criteria, workspaceId } = await this.prepareKitchen(params);
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
      kitchen: {
        idempotencyKey: params.idempotencyKey,
        requestFingerprint: fingerprint,
        mode: "accompanied",
        workflowMode: params.workflowMode ?? "fixed",
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
    const packId = params.packId ?? profile.workflowPack ?? "kitchen";
    const pack = await this.options.packs.resolveFor(cwd, packId);
    if (!pack) throw new Error(`Workflow pack ${packId} is not installed`);
    for (const role of Object.keys(profile.roles ?? {})) {
      if (!pack.roles[role]) throw new Error(`Project profile names unknown role ${role}`);
    }
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
    for (const role of Object.values(profile.roles ?? {}))
      await this.options.controller.validateProvider({
        provider: role.provider,
        model: role.model,
        cwd,
      });
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
  ): Promise<TeamState> {
    await this.store.commit(teamId, async (draft) => {
      const runtime = (draft.team.runtime ??= runtimeState());
      if (action === "accept")
        return { events: await this.acceptKitchen(draft, actorId), result: null };
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

  private async acceptKitchen(draft: TeamState, actorId: string): Promise<TeamEventDraft[]> {
    if (draft.team.status === "done" && draft.team.kitchen?.acceptedCommit) return [];
    const { root, commit } = acceptanceCandidate(draft);
    if (!actorId.trim()) throw new Error("Human acceptance requires an actor");
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
      if (["done", "canceled"].includes(draft.team.status)) throw new Error("This team is closed");
      const events: TeamEventDraft[] = [{ type: "human.message", actor, text }];
      for (const item of Object.values(draft.items)) {
        if (item.phase === "blocked") {
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
      if (["done", "canceled"].includes(draft.team.status)) throw new Error("This team is closed");
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
    const role = team ? this.pack(team.team).roles[caller.binding.role] : undefined;
    await this.verifyReportCheckout(
      agentId,
      team,
      team ? this.pack(team.team).roles[caller.binding.role] : undefined,
      payload,
    );
    const branch =
      role?.workspace === "own-worktree"
        ? await currentBranch((await this.options.controller.get(agentId))?.cwd ?? "")
        : undefined;
    try {
      const result = await this.store.commit(caller.teamId, (draft) => {
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
            expandWork(draft, this.pack(draft.team), binding, input, events);
        }
        chargeBinding(draft, binding, this.now().getTime());
        const item = applyReport(draft, this.pack(draft.team), binding, payload, events);
        return {
          events,
          result: `Report accepted. ${item.title} is now in ${item.phase}. Stop here.`,
        };
      });
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

  private async verifyReportCheckout(
    agentId: string,
    state: TeamState | null,
    role: Role | undefined,
    payload: TeamReportPayload,
  ): Promise<void> {
    if (
      state &&
      this.pack(state.team).requireVerification &&
      role?.id === "verifier" &&
      payload.outcome === "pass"
    ) {
      const record = await this.options.controller.get(agentId);
      if (!record) throw new ReportRejectedError("Verifier session is unavailable");
      const commits = payload.artifacts?.filter((artifact) => artifact.kind === "commit") ?? [];
      if (commits.length !== 1)
        throw new ReportRejectedError("Verification requires exactly one commit artifact");
      await this.assertVerifiedCheckout(record.cwd, commits[0]!.ref);
    }
  }

  async requestWork(agentId: string, input: WorkRequestInput): Promise<string> {
    const caller = await this.resolveCaller(agentId);
    if (!caller) throw new ReportRejectedError("This session is not seated in a team");
    return this.store.commit(caller.teamId, (draft) => {
      const events: TeamEventDraft[] = [];
      if (draft.team.kitchen?.workflowMode !== "self-organizing")
        throw new ReportRejectedError("Work requests require a self-organizing Kitchen");
      const child = expandWork(
        draft,
        this.pack(draft.team),
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
    await this.store.commit(teamId, async (draft) => {
      const events: TeamEventDraft[] = [];
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
      if (errored && binding.errors < MAX_ERROR_RETRIES) {
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

  private async runDecision(teamId: string, decisionId: string): Promise<void> {
    const state = await this.store.get(teamId);
    const decision = state?.decisions[decisionId];
    if (
      (decision?.kind === "start-role" || decision?.kind === "message-role") &&
      (await this.activeCookCount()) >=
        Math.min(
          LIMITS.maxActiveCooks,
          this.options.maxConcurrentAgents?.() ?? LIMITS.maxActiveCooks,
        )
    )
      return;
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

  private async execute(
    state: TeamState,
    decision: Decision,
  ): Promise<(draft: TeamState) => TeamEventDraft[]> {
    const pack = this.pack(state.team);
    const item = state.items[decision.workItemId]!;
    switch (decision.kind) {
      case "start-role":
        return this.startRole(state, pack, item, decision);
      case "message-role": {
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
    const profile = state.team.roleProfiles[roleId];
    if (!profile) throw new Error(`No harness bound for role ${roleId}`);
    const profileName = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;

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

    let agentId = await this.findAgentForDecision(decision.id);
    if (!agentId) {
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
    if (role.skills.length) lines.push("", `## Skills to use`, role.skills.join(", "));
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
      '- Optional needs shape: {"kind":"human","text":"the decision needed"}; kind must be human, research or split.',
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
        'Use optional workRequests array beside report. Each request has requestId (stable nonempty string), title, objective, acceptanceCriteria (nonempty string array), optional parentId and dependsOn/conflictsWith item IDs. Report needs:{kind:"split",text:"why"} or needs:{kind:"research",text:"why"} and wait for verified children. Maximum depth two, ten delegated items per run.',
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
    const limit = await this.store.commit(teamId, (draft) => {
      if (draft.team.status === "done" || draft.team.status === "canceled")
        return { events: [], result: false };
      const runtime = (draft.team.runtime ??= runtimeState());
      for (const binding of Object.values(draft.bindings))
        chargeBinding(draft, binding, this.now().getTime(), true);
      runtime.usage.tokensAvailable = agents.length > 0 && observed.length === agents.length;
      if (observed.length)
        runtime.usage.observedTokens = observed.reduce(
          (total, agent) =>
            total + agent.usageTotals!.inputTokens + agent.usageTotals!.outputTokens,
          0,
        );
      const reason = runtimeLimitReason(draft);
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
    pack.requireVerification && (role.id === "verifier" || role.id === "integrator");
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
    roles: z
      .record(
        z.string(),
        z.object({
          provider: z.string().min(1),
          model: z.string().min(1).optional(),
          thinking: z.string().min(1).optional(),
          mode: z.string().min(1).optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export async function readProjectProfile(
  cwd: string,
): Promise<z.infer<typeof ProjectProfileSchema>> {
  let text: string;
  try {
    text = await readFile(join(cwd, ".agent-factory", "project.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return ProjectProfileSchema.parse(JSON.parse(text));
}

function runtimeState(): NonNullable<Team["runtime"]> {
  return {
    limits: { ...LIMITS },
    usage: { activeMs: 0, roleActiveMs: {}, tokensAvailable: false },
  };
}

function chargeBinding(state: TeamState, binding: Binding, now: number, continuing = false): void {
  if (!binding.activeStartedAt) return;
  const elapsed = Math.max(0, now - Date.parse(binding.activeStartedAt));
  const runtime = (state.team.runtime ??= runtimeState());
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
        acceptanceCriteria: input.acceptanceCriteria,
        workflowMode: input.workflowMode ?? "fixed",
        scheduleId: input.scheduleId,
        kind: input.kind ?? "feature",
        sourceAgentId: input.sourceAgentId,
        workspaceId: input.workspaceId,
      }),
    )
    .digest("hex");
}

function validateKitchenInput(params: StartKitchenInput): void {
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

function runtimeLimitReason(state: TeamState): string | undefined {
  const runtime = state.team.runtime!;
  if (runtime.limitReason) return runtime.limitReason;
  const exhausted = Object.values(state.bindings).find(
    (binding) => (binding.activeMs ?? 0) >= runtime.limits.roleActiveMs,
  );
  if (exhausted) return `${exhausted.role} reached 60 minutes active time`;
  if (runtime.usage.activeMs >= runtime.limits.totalActiveMs)
    return "Team reached four hours aggregate active time";
  if ((runtime.usage.observedTokens ?? 0) >= runtime.limits.observedTokens)
    return "Team reached 500,000 observed tokens";
  return undefined;
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
