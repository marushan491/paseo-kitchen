import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MigrationSourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["team", "profiles", "packs"]),
  path: z.string(),
  count: z.number().int(),
  activeJobs: z.number().int(),
  warnings: z.array(z.string()),
});
export const factoryMigrationInspect = defineRpc({
  name: "factory.migration.inspect",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({
    sources: z.array(MigrationSourceSchema),
    warnings: z.array(z.string()),
    backupAvailable: z.boolean(),
  }),
});
export const factoryMigrationImport = defineRpc({
  name: "factory.migration.import",
  input: z.object({
    cwd: z.string().optional(),
    sourceIds: z.array(z.string()).min(1),
    confirmBackup: z.literal(true),
    actorId: z.string().min(1),
  }),
  output: z.object({
    backupRef: z.string(),
    imported: z.array(z.string()),
    skipped: z.array(z.string()),
    errors: z.array(z.string()),
  }),
});
