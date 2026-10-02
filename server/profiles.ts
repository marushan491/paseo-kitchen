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
  async resolve(base: RoleProfileOverride & { provider: string }, override?: RoleProfileOverride) {
    if (!override) return { ...base };
    const selected = override.workflowProfileId
      ? (await this.list()).find((entry) => entry.id === override.workflowProfileId)
      : undefined;
    if (override.workflowProfileId && !selected)
      throw new Error(`Workflow profile ${override.workflowProfileId} not found`);
    const patch = { ...selected?.profile, ...override };
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
