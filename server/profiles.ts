import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  WorkflowProfileSchema,
  type WorkflowProfile,
  type RoleProfileOverride,
} from "../shared/factory-contracts.js";
import { writeJsonFileAtomic } from "./atomic-file.js";

export class WorkflowProfiles {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly storageRoot: string) {}
  async list(): Promise<WorkflowProfile[]> {
    try {
      return z
        .array(WorkflowProfileSchema)
        .parse(
          JSON.parse(await readFile(join(this.storageRoot, "workflow-profiles.json"), "utf8")),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  save(profile: WorkflowProfile): Promise<WorkflowProfile> {
    const parsed = WorkflowProfileSchema.parse(profile);
    if (parsed.brief && !parsed.targetRole)
      throw new Error("A described role needs an executable target role");
    if (
      parsed.profile.steps &&
      new Set(parsed.profile.steps.map((step) => step.id)).size !== parsed.profile.steps.length
    )
      throw new Error("Workflow step IDs must be unique");
    return this.mutate(async () => {
      const profiles = (await this.list()).filter((entry) => entry.id !== parsed.id);
      profiles.push(parsed);
      await writeJsonFileAtomic(join(this.storageRoot, "workflow-profiles.json"), profiles);
      return parsed;
    });
  }
  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      const profiles = await this.list();
      if (!profiles.some((entry) => entry.id === id))
        throw new Error(`Workflow profile ${id} not found`);
      await writeJsonFileAtomic(
        join(this.storageRoot, "workflow-profiles.json"),
        profiles.filter((entry) => entry.id !== id),
      );
    });
  }
  async resolve(
    base: RoleProfileOverride & { provider: string },
    override?: RoleProfileOverride,
    role?: string,
    packId?: string,
  ) {
    if (!override) return { ...base };
    const selected = override.workflowProfileId
      ? (await this.list()).find((entry) => entry.id === override.workflowProfileId)
      : undefined;
    if (override.workflowProfileId && !selected)
      throw new Error(`Workflow profile ${override.workflowProfileId} not found`);
    assertRoleMapping(selected, role, packId);
    const patch = { ...selected?.profile, ...override };
    if (selected?.brief)
      patch.instructions = roleInstructions({
        ...selected,
        profile: {
          ...selected.profile,
          instructions: override.instructions ?? selected.profile.instructions,
        },
      });
    const resolved = { ...base, ...patch };
    if (
      resolved.steps &&
      new Set(resolved.steps.map((step) => step.id)).size !== resolved.steps.length
    )
      throw new Error("Workflow step IDs must be unique");
    if (patch.provider && patch.provider !== base.provider && !patch.model) delete resolved.model;
    return resolved;
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(action);
    this.chain = next;
    return next;
  }
}

export function roleInstructions(profile: WorkflowProfile): string {
  if (!profile.brief) return profile.profile.instructions || "";
  return [
    `Role: ${profile.name}`,
    `Task: ${profile.brief.task}`,
    `Responsibility: ${profile.brief.responsibility}`,
    `Expected outcome: ${profile.brief.outcome}`,
    profile.profile.instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function assertRoleMapping(profile: WorkflowProfile | undefined, role?: string, packId?: string) {
  if (!profile?.targetRole || !role || profile.targetRole === role) return;
  if (packId === "kitchen-single" && role === "integrator" && profile.targetRole === "developer")
    return;
  throw new Error(`Role ${profile.name} is mapped to ${profile.targetRole}, not ${role}`);
}
