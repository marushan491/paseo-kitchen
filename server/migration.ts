import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, lstat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  RoleProfileOverrideSchema,
  TeamStateSchema,
  TeamEventSchema,
  type TeamState,
} from "../shared/factory-contracts.js";
import { factoryMigrationInspect, factoryMigrationImport } from "../shared/migration-contracts.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { withStorageLock } from "./storage-lock.js";
import type { TeamService } from "./service.js";

const legacyProject = z.object({
  roles: z.record(z.string(), RoleProfileOverrideSchema).optional(),
  workflowPack: z.string().optional(),
});
type Source = z.infer<typeof import("../shared/migration-contracts.js").MigrationSourceSchema>;
const sourceId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 24);
async function exists(path: string) {
  try {
    return !(await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export class NativeMigration {
  constructor(
    private readonly home: string,
    private readonly storageRoot: string,
    private readonly service: TeamService,
  ) {
    if (!isAbsolute(home) || !isAbsolute(storageRoot))
      throw new Error("Migration requires explicit absolute host and storage directories");
  }
  async inspect(cwd?: string) {
    const sources: Source[] = [],
      warnings: string[] = [];
    const teams = join(this.home, "teams");
    if (await exists(teams))
      for (const entry of await readdir(teams, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^team_[A-Za-z0-9_-]+$/.test(entry.name)) continue;
        const path = join(teams, entry.name, "state.json");
        if (!(await exists(path))) continue;
        try {
          const state = TeamStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
          const active = !["done", "canceled"].includes(state.team.status);
          sources.push({
            id: sourceId(path),
            kind: "team",
            path,
            count: 1,
            activeJobs: active ? 1 : 0,
            warnings: [
              active
                ? "Active native job is preserved and will not be imported or resumed."
                : "Imported legacy jobs are read-only history; acceptance is not inferred.",
            ],
          });
        } catch {
          warnings.push(`Unsupported native team format: ${entry.name}`);
        }
      }
    if (cwd) {
      if (!isAbsolute(cwd)) throw new Error("Migration project directory must be absolute");
      const path = join(cwd, ".pandaos", "project.json");
      if (await exists(path)) {
        const project = legacyProject.parse(JSON.parse(await readFile(path, "utf8")));
        sources.push({
          id: sourceId(path),
          kind: "profiles",
          path,
          count: Object.keys(project.roles ?? {}).length,
          activeJobs: 0,
          warnings: [
            "Validated role defaults are copied into the workflow library. Original project config is retained.",
          ],
        });
      }
    }
    const packs = join(this.home, "packs");
    if (await exists(packs))
      for (const entry of await readdir(packs, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
        const path = join(packs, entry.name);
        if (await exists(join(path, "pack.mjs")))
          sources.push({
            id: sourceId(path),
            kind: "packs",
            path,
            count: 1,
            activeJobs: 0,
            warnings: [
              "Trusted executable pack copied without running it. Reload validates it; incompatible native imports remain unavailable.",
            ],
          });
      }
    return { sources, warnings, backupAvailable: true };
  }
  async import(sourceIds: string[], cwd?: string) {
    return withStorageLock(join(this.storageRoot, "migration.lock"), async () => {
      const inspection = await this.inspect(cwd);
      const selected = sourceIds.map((id) => {
        const source = inspection.sources.find((value) => value.id === id);
        if (!source) throw new Error(`Migration source ${id} is unavailable; inspect again`);
        return source;
      });
      const backupRef = join(this.storageRoot, "migration-backups", randomUUID());
      await mkdir(backupRef, { recursive: true, mode: 0o700 });
      const imported: string[] = [],
        skipped: string[] = [],
        errors: string[] = [];
      for (const source of selected) {
        if (source.activeJobs) {
          skipped.push(`${source.id}: active native job`);
          continue;
        }
        try {
          await cp(
            source.kind === "team" ? join(source.path, "..") : source.path,
            join(backupRef, source.id),
            { recursive: true, dereference: false, errorOnExist: true, force: false },
          );
          if (source.kind === "team") {
            const original = TeamStateSchema.parse(JSON.parse(await readFile(source.path, "utf8")));
            if (!["done", "canceled"].includes(original.team.status)) {
              skipped.push(`${source.id}: job became active`);
              continue;
            }
            if (await this.service.store.get(original.team.id)) {
              skipped.push(`${source.id}: already present`);
              continue;
            }
            const state: TeamState = {
              ...original,
              team: {
                ...original.team,
                importedFrom: {
                  source: source.path,
                  importedAt: new Date().toISOString(),
                  readOnly: true,
                },
              },
            };
            let events: import("./store.js").TeamEventDraft[] = [];
            const eventFile = join(source.path, "..", "events.jsonl");
            if (await exists(eventFile))
              events = (await readFile(eventFile, "utf8"))
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const event = TeamEventSchema.parse({ ...JSON.parse(line), id: "legacy" });
                  return {
                    type: event.type,
                    actor: event.actor,
                    workItemId: event.workItemId,
                    text: event.text,
                    data: { ...event.data, importedAt: event.at },
                  };
                });
            await this.service.store.create(state, events);
            imported.push(state.team.id);
          } else if (source.kind === "profiles") {
            const result = await this.importProfiles(source, cwd);
            imported.push(...result.imported);
            skipped.push(...result.skipped);
          } else {
            const destination = join(this.storageRoot, "imported-packs", basename(source.path));
            if (await exists(destination)) {
              skipped.push(`${source.id}: pack already present`);
              continue;
            }
            await cp(source.path, destination, {
              recursive: true,
              dereference: false,
              errorOnExist: true,
              force: false,
              filter: async (path) => {
                if ((await lstat(path)).isSymbolicLink())
                  throw new Error("Pack symlinks are not migrated");
                return true;
              },
            });
            imported.push(destination);
          }
        } catch (error) {
          errors.push(`${source.id}: ${error instanceof Error ? error.message : "Import failed"}`);
        }
      }
      await writeJsonFileAtomic(join(backupRef, "manifest.json"), {
        at: new Date().toISOString(),
        sources: selected,
        imported,
        skipped,
        errors,
      });
      return { backupRef, imported, skipped, errors };
    });
  }
  private async importProfiles(source: Source, cwd?: string) {
    const project = legacyProject.parse(JSON.parse(await readFile(source.path, "utf8")));
    const existing = await this.service.profiles.list(),
      imported: string[] = [],
      skipped: string[] = [];
    for (const [role, profile] of Object.entries(project.roles ?? {})) {
      const id = `legacy-${source.id}-${role.replace(/[^A-Za-z0-9_-]/g, "-")}`;
      if (existing.some((value) => value.id === id)) {
        skipped.push(`${id}: already imported`);
        continue;
      }
      await this.service.profiles.save({
        id,
        name: `Imported ${role} · ${basename(cwd ?? this.home)}`,
        profile: RoleProfileOverrideSchema.omit({ workflowProfileId: true }).parse(profile),
      });
      imported.push(id);
    }
    return { imported, skipped };
  }
}
export function registerMigration(
  server: PluginServerContext,
  options: {
    home: () => Promise<string>;
    storageRoot: () => Promise<string>;
    service: (paseo: import("@getpaseo/client").PaseoApi) => Promise<TeamService>;
  },
) {
  const ready = async (paseo: import("@getpaseo/client").PaseoApi) =>
    new NativeMigration(
      await options.home(),
      await options.storageRoot(),
      await options.service(paseo),
    );
  server.handle(factoryMigrationInspect, async (input, { paseo }) =>
    (await ready(paseo)).inspect(input.cwd),
  );
  server.handle(factoryMigrationImport, async (input, { paseo }) =>
    (await ready(paseo)).import(input.sourceIds, input.cwd),
  );
}
