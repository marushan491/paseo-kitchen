import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  ImprovementRuleSchema,
  ImprovementRunSchema,
  factoryImprovementsList,
  factoryImprovementsSave,
  factoryImprovementsScan,
  type ImprovementRule,
  type ImprovementRun,
} from "../shared/improvement-contracts.js";
import type { TeamService } from "./service.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { withStorageLock } from "./storage-lock.js";

const StateSchema = z.object({
  rules: z.array(ImprovementRuleSchema),
  runs: z.array(ImprovementRunSchema),
});
export class ImprovementLoop {
  constructor(
    private readonly directory: string,
    private readonly service: Pick<TeamService, "store" | "startKitchen">,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async list() {
    try {
      return StateSchema.parse(
        JSON.parse(await readFile(join(this.directory, "improvements.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], runs: [] };
      throw error;
    }
  }
  async save(input: ImprovementRule) {
    const rule = ImprovementRuleSchema.parse(input);
    if (["kitchen-insights", "kitchen-gardener"].includes(rule.target.packId ?? "kitchen"))
      throw new Error("Improvement execution must use a verified implementation pack");
    return withStorageLock(join(this.directory, "improvements.lock"), async () => {
      const state = await this.list();
      state.rules = [...state.rules.filter((value) => value.id !== rule.id), rule];
      await writeJsonFileAtomic(join(this.directory, "improvements.json"), state);
      return rule;
    });
  }
  async scan() {
    return withStorageLock(join(this.directory, "improvements.lock"), async () => {
      const state = await this.list(),
        started: string[] = [],
        errors: string[] = [];
      const at = this.now().toISOString();
      for (const rule of state.rules.filter((value) => value.enabled)) {
        const previous = state.runs.filter((value) => value.ruleId === rule.id);
        let run = previous.find((value) => value.status === "pending");
        if (!run) {
          if (
            previous.length >= rule.maxRuns ||
            previous.some((value) => Date.parse(at) - Date.parse(value.at) < rule.cooldownMs)
          )
            continue;
          if (await this.hasActiveRun(previous)) continue;
          const sourceRefs = await this.sourceRefs(rule, previous);
          if (sourceRefs.length < rule.minOccurrences) continue;
          const id = createHash("sha256")
            .update(JSON.stringify([rule.id, sourceRefs.sort()]))
            .digest("hex");
          run = {
            id,
            ruleId: rule.id,
            sourceRefs,
            at,
            status: "pending",
            attempts: 0,
            target: rule.target,
          };
          state.runs.push(run);
          await writeJsonFileAtomic(join(this.directory, "improvements.json"), state);
        }
        if (run.lastAttemptAt && Date.parse(at) - Date.parse(run.lastAttemptAt) < 60_000) continue;
        run.attempts++;
        run.lastAttemptAt = at;
        const target = run.target ?? rule.target;
        try {
          const team = await this.service.startKitchen({
            ...target,
            kind: "maintenance",
            objective: `${target.objective}\n\nRecorded Kitchen evidence triggering this bounded improvement:\n${run.sourceRefs.join("\n")}\nInspect the recorded causes. Keep the change within the approved scope. Review, independent verification and final acceptance remain required.`,
            idempotencyKey: `improvement:${run.id}`,
          });
          run.status = "started";
          run.teamId = team.team.id;
          delete run.error;
          started.push(team.team.id);
        } catch (error) {
          run.error = error instanceof Error ? error.message : "Improvement start failed";
          if (run.attempts >= 3) run.status = "failed";
          errors.push(`${rule.name}: ${run.error}`);
        }
        await writeJsonFileAtomic(join(this.directory, "improvements.json"), state);
      }
      return { started, errors };
    });
  }
  private async hasActiveRun(runs: ImprovementRun[]) {
    for (const run of runs) {
      if (!run.teamId) continue;
      const state = await this.service.store.get(run.teamId);
      if (state && !["done", "canceled"].includes(state.team.status)) return true;
    }
    return false;
  }
  private async sourceRefs(rule: ImprovementRule, runs: ImprovementRun[]) {
    const used = new Set(runs.flatMap((value) => value.sourceRefs)),
      refs: string[] = [];
    for (const id of await this.service.store.listIds()) {
      const state = await this.service.store.get(id);
      if (
        !state ||
        state.team.importedFrom ||
        !rule.sourcePackIds.includes(state.team.packId) ||
        runs.some((value) => value.teamId === id)
      )
        continue;
      refs.push(
        ...(await this.service.store.events(id))
          .filter((event) => rule.eventTypes.includes(event.type) && !used.has(event.id))
          .map((event) => event.id),
      );
    }
    return refs;
  }
}
export function registerImprovements(
  server: PluginServerContext,
  options: {
    storageRoot: () => Promise<string>;
    service: (paseo: import("@getpaseo/client").PaseoApi) => Promise<TeamService>;
  },
) {
  let loop: ImprovementLoop | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let initializing: Promise<ImprovementLoop> | undefined;
  let scanning: Promise<unknown> | undefined;
  const ready = async (paseo: import("@getpaseo/client").PaseoApi) => {
    if (disposed) throw new Error("Kitchen improvement loop is stopped");
    if (loop) return loop;
    if (initializing) return initializing;
    initializing = (async () => {
      loop = new ImprovementLoop(await options.storageRoot(), await options.service(paseo));
      if (!disposed)
        timer = setInterval(() => {
          if (scanning || disposed) return;
          scanning = loop!
            .scan()
            .catch((error) =>
              console.error(
                "Kitchen improvement scan failed",
                error instanceof Error ? error.message : "Unknown error",
              ),
            )
            .finally(() => {
              scanning = undefined;
            });
        }, 60_000);
      return loop;
    })().finally(() => {
      initializing = undefined;
    });
    return initializing;
  };
  server.handle(factoryImprovementsList, async (_, { paseo }) => (await ready(paseo)).list());
  server.handle(factoryImprovementsSave, async (input, { paseo }) =>
    (await ready(paseo)).save(input.rule),
  );
  server.handle(factoryImprovementsScan, async (_, { paseo }) => (await ready(paseo)).scan());
  return {
    initialize: ready,
    cleanup: async () => {
      disposed = true;
      if (timer) clearInterval(timer);
      await initializing?.catch(() => undefined);
      await scanning;
    },
  };
}
