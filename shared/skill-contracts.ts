import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const InstalledSkillSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2048),
  providers: z.array(z.string()),
  scope: z.enum(["host", "project"]),
});
export const SkillCatalogSchema = z.object({
  skills: z.array(InstalledSkillSchema),
  warnings: z.array(z.string()),
  providers: z.array(z.string()),
  source: z.literal("filesystem"),
});
export type InstalledSkill = z.infer<typeof InstalledSkillSchema>;
export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;
export const factorySkillsList = defineRpc({
  name: "factory.skills.list",
  input: z.object({ cwd: z.string().min(1).optional(), provider: z.string().min(1).optional() }),
  output: SkillCatalogSchema,
});
