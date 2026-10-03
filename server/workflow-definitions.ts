import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowPreview,
  type FileCondition,
} from "../shared/workflow-contracts.js";
import { validatePack, type WorkflowPack, type PackRegistry } from "./pack.js";
import { withStorageLock } from "./storage-lock.js";
import { writeJsonFileAtomic } from "./atomic-file.js";

export function definitionFromPack(pack: WorkflowPack, id: string): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    id,
    revision: 0,
    basePackId: pack.id,
    basePackVersion: pack.version,
    title: pack.title,
    roles: pack.roles,
    boards: pack.boards,
    runtimePolicy: {
      maxReturns: pack.maxReturns,
      maxDelegationDepth: pack.maxDelegationDepth,
      maxDelegatedItems: pack.maxDelegatedItems,
      dependencyPhase: pack.dependencyPhase,
    },
  });
}

export function matchesChangedFiles(condition: FileCondition, files: string[]): boolean {
  return files.some((file) =>
    condition.any.some(
      (rule) =>
        (!rule.prefix || file.startsWith(rule.prefix)) &&
        (!rule.suffix || file.endsWith(rule.suffix)),
    ),
  );
}

export function validateDefinition(
  input: WorkflowDefinition,
  base: WorkflowPack,
): WorkflowDefinition {
  const value = WorkflowDefinitionSchema.parse(input);
  if (value.id === base.id)
    throw new Error("A workflow variant needs a new ID distinct from its baseline");
  if (!base.requireVerification || !["kitchen", "kitchen-single"].includes(base.id))
    throw new Error("Workflow variants require a verified Kitchen base pack");
  if (value.basePackId !== base.id || value.basePackVersion !== base.version)
    throw new Error("Workflow base pack version conflict");
  if (
    JSON.stringify(value.boards.root) !==
    JSON.stringify(definitionFromPack(base, value.id).boards.root)
  )
    throw new Error("Combined integration, verification and human acceptance cannot be changed");
  if (
    JSON.stringify(verifierPolicy(value.roles.verifier)) !==
    JSON.stringify(verifierPolicy(base.roles.verifier))
  )
    throw new Error("Independent Verifier read-only workspace and tools cannot be changed");
  validateRoles(value);
  validateBoards(value, base);
  validateCompletion(value, base);
  validatePack({ ...base, roles: value.roles, boards: value.boards as WorkflowPack["boards"] });
  return value;
}

function validateRoles(value: WorkflowDefinition) {
  if (value.roles.developer?.workspace !== "own-worktree")
    throw new Error("Build must create an isolated worktree for the feature");
  for (const id of Object.keys(value.roleProfiles ?? {}))
    if (!value.roles[id]) throw new Error("Model preference needs a known workflow role");
  for (const [id, role] of Object.entries(value.roles)) {
    if (role.canEdit && role.workspace === "team")
      throw new Error("Editable roles must use an isolated worktree");
    if (role.id !== id) throw new Error("Workflow role IDs must match their keys");
    if (id !== "po" && role.tools.includes("item_plan"))
      throw new Error("Only the planning role may plan the mission");
    if (
      role.communication?.investigation === "request-work" &&
      !role.tools.includes("item_request_work")
    )
      throw new Error("Work requests require the actual work-request route");
  }
}

function validateCompletion(value: WorkflowDefinition, base: WorkflowPack) {
  const board = value.boards.item;
  if (
    !board ||
    JSON.stringify(protectedPhase(board.phases.verify)) !==
      JSON.stringify(protectedPhase(base.boards.item.phases.verify))
  )
    throw new Error("Independent item verification and returns cannot be changed");
  if (
    board.initialPhase !== base.boards.item.initialPhase ||
    !board.phases.review ||
    board.phases.review.role !== "reviewer"
  )
    throw new Error("Editable review cannot be removed");
  let completed = false;
  const visited = new Set<string>();
  const walk = (phaseId: string, review: boolean, verify: boolean, developer: boolean) => {
    const phase = board.phases[phaseId];
    if (!phase) throw new Error("Unknown workflow phase");
    validateFeatureWorkspace(value, phase.role, developer);
    developer ||= phase.role === "developer";
    if (phase.role && value.roles[phase.role]?.canEdit) verify = false;
    review ||= phase.role === "reviewer";
    verify ||= phase.role === "verifier";
    const key = `${phaseId}:${review}:${verify}:${developer}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (phase.kind === "terminal" && phaseId !== "canceled") completed = true;
    if (phase.kind === "terminal" && phaseId !== "canceled" && (!review || !verify))
      throw new Error("Every completion path must include review and independent verification");
    for (const target of [
      ...Object.values(phase.outcomes ?? {}),
      phase.next,
      phase.completeWithChildren,
      phase.skipTo,
    ])
      if (target) walk(target, review, verify, developer);
  };
  walk(board.initialPhase, false, false, false);
  if (!completed) throw new Error("Workflow has no reachable verified completion");
}

function validateFeatureWorkspace(
  value: WorkflowDefinition,
  role: string | undefined,
  developer: boolean,
) {
  if (!developer && value.roles[role ?? ""]?.workspace === "item-worktree")
    throw new Error("Roles using the feature worktree must run after Build has created it");
}

function validateCondition(
  value: WorkflowDefinition,
  phase: WorkflowDefinition["boards"][string]["phases"][string],
  boardId: string,
  board: WorkflowDefinition["boards"][string],
) {
  if (!phase.condition) {
    if (phase.skipTo) throw new Error("Skip target requires a file condition");
    return;
  }
  if (
    boardId !== "item" ||
    phase.kind !== "working" ||
    !phase.skipTo ||
    !board.phases[phase.skipTo]
  )
    throw new Error("Conditional checks need an item working phase and a known skip target");
  for (const rule of phase.condition.any) {
    if (
      (!rule.prefix && !rule.suffix) ||
      rule.prefix?.startsWith("/") ||
      rule.prefix?.split("/").includes("..") ||
      rule.suffix?.includes("/")
    )
      throw new Error("File conditions use relative path prefixes or file suffixes");
  }
  if (value.roles[phase.role ?? ""]?.canEdit)
    throw new Error("Conditional checks must be read-only");
  validateSkipChain(board, phase.skipTo);
}
function validateSkipChain(board: WorkflowDefinition["boards"][string], phaseId: string) {
  const seen = new Set<string>();
  let current = phaseId;
  for (;;) {
    if (seen.has(current)) throw new Error("Conditional skip connections cannot form a cycle");
    seen.add(current);
    const target = board.phases[current];
    if (!target) throw new Error("Unknown conditional skip target");
    if (!target.condition) {
      if (target.role !== "verifier")
        throw new Error("Unmatched conditional checks must continue to independent verification");
      return;
    }
    if (!target.skipTo) throw new Error("Conditional check needs a skip target");
    current = target.skipTo;
  }
}

function validateBoards(value: WorkflowDefinition, base: WorkflowPack) {
  for (const [boardId, board] of Object.entries(value.boards)) {
    if (!base.boards[boardId]) throw new Error("Adding boards is not supported");
    if (Object.keys(board.phases).length > 48) throw new Error("Workflow has too many phases");
    for (const phase of Object.values(board.phases))
      validateCondition(value, phase, boardId, board);
  }
}

export function packFromDefinition(
  definition: WorkflowDefinition,
  base: WorkflowPack,
): WorkflowPack {
  const value = validateDefinition(definition, base);
  return {
    ...base,
    id: `workflow-${value.id}`,
    version: value.revision,
    title: value.title,
    roles: structuredClone(value.roles),
    boards: structuredClone(value.boards) as WorkflowPack["boards"],
  };
}

export class WorkflowDefinitions {
  constructor(
    private readonly root: string,
    private readonly packs: PackRegistry,
  ) {}
  private path() {
    return join(this.root, "workflow-definitions.json");
  }
  validate(input: WorkflowDefinition): WorkflowDefinition {
    const base = this.packs.get(input.basePackId);
    if (!base) throw new Error("Workflow base pack not found");
    return validateDefinition(input, base);
  }
  async list(): Promise<WorkflowDefinition[]> {
    try {
      return z
        .array(WorkflowDefinitionSchema)
        .parse(JSON.parse(await readFile(this.path(), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async get(id: string): Promise<WorkflowDefinition> {
    const value = (await this.list()).find((entry) => entry.id === id);
    if (!value) throw new Error(`Workflow ${id} not found`);
    return value;
  }
  save(input: WorkflowDefinition, expectedRevision: number): Promise<WorkflowDefinition> {
    return withStorageLock(`${this.path()}.lock`, async () => {
      const base = this.packs.get(input.basePackId);
      if (!base) throw new Error("Workflow base pack not found");
      const value = validateDefinition(input, base);
      const all = await this.list();
      const current = all.find((entry) => entry.id === value.id);
      if ((current?.revision ?? 0) !== expectedRevision || value.revision !== expectedRevision)
        throw new Error("Workflow revision conflict; reload the workflow before applying changes");
      const saved = {
        ...value,
        runtimePolicy: {
          ...(value.runtimePolicy ?? definitionFromPack(base, value.id).runtimePolicy!),
          dependencyPhase: base.dependencyPhase,
        },
        revision: expectedRevision + 1,
      };
      await writeJsonFileAtomic(this.path(), [
        ...all.filter((entry) => entry.id !== value.id),
        saved,
      ]);
      return saved;
    });
  }
  async preview(
    definition: WorkflowDefinition,
    result: { summary: string[]; confidence: number; model: string },
  ): Promise<WorkflowPreview> {
    const base = this.packs.get(definition.basePackId);
    if (!base) throw new Error("Workflow base pack not found");
    validateDefinition(definition, base);
    const preview: WorkflowPreview = {
      previewId: randomUUID(),
      definition,
      expectedRevision: definition.revision,
      ...result,
      source: "jev",
      requiresConfirmation: true,
    };
    await writeJsonFileAtomic(
      join(this.root, "workflow-previews", `${preview.previewId}.json`),
      preview,
    );
    return preview;
  }
  async apply(id: string, expectedRevision: number): Promise<WorkflowDefinition> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid workflow preview ID");
    const { WorkflowPreviewSchema } = await import("../shared/workflow-contracts.js");
    const preview = WorkflowPreviewSchema.parse(
      JSON.parse(await readFile(join(this.root, "workflow-previews", `${id}.json`), "utf8")),
    );
    if (preview.expectedRevision !== expectedRevision)
      throw new Error("Workflow preview revision conflict");
    return this.save(preview.definition, expectedRevision);
  }
}

export function packFromSnapshot(value: WorkflowDefinition): WorkflowPack {
  if (!value.runtimePolicy)
    throw new Error("Workflow snapshot is missing its pinned runtime policy");
  return validatePack({
    id: `workflow-${value.id}`,
    version: value.revision,
    title: value.title,
    boards: structuredClone(value.boards) as WorkflowPack["boards"],
    roles: structuredClone(value.roles),
    maxParallel: 4,
    requireVerification: true,
    ...value.runtimePolicy,
  });
}

function verifierPolicy(
  role: WorkflowDefinition["roles"][string] | WorkflowPack["roles"][string] | undefined,
) {
  if (!role) return null;
  return {
    id: role.id,
    canEdit: role.canEdit,
    workspace: role.workspace,
    tools: role.tools,
    evidence: role.evidence,
  };
}
function protectedPhase(phase: WorkflowDefinition["boards"][string]["phases"][string] | undefined) {
  if (!phase) return null;
  const { title: _title, maxReturns: _maxReturns, ...policy } = phase;
  return policy;
}
