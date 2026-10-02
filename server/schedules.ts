import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import { parseCronExpression } from "@getpaseo/protocol/schedule/cron-expression";
import {
  KitchenScheduleSchema,
  KitchenScheduleSaveSchema,
  type KitchenSchedule,
} from "../shared/factory-contracts.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import type { TeamService } from "./service.js";

const StoreSchema = z.object({ schedules: z.record(z.string(), KitchenScheduleSchema) });
type ScheduleRun = KitchenSchedule["runs"][number];
export interface KitchenSchedulesOptions {
  storageRoot: string;
  service: Pick<TeamService, "startKitchen">;
  now?: () => Date;
  timers?: boolean;
  onError?: (error: unknown) => void;
}
export class KitchenSchedules {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly now: () => Date;
  private readonly manualRuns = new Map<string, Promise<KitchenSchedule | null>>();
  private readonly file: string;
  constructor(private readonly options: KitchenSchedulesOptions) {
    this.now = options.now ?? (() => new Date());
    this.file = join(options.storageRoot, "schedules", "state.json");
  }
  async start() {
    this.stopped = false;
    await this.tick();
    if (!this.stopped && this.options.timers !== false)
      this.timer = setInterval(
        () => void this.tick().catch((error) => (this.options.onError ?? console.error)(error)),
        2_000,
      );
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.queue.catch(() => {});
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(operation);
    this.queue = run;
    return run;
  }
  private async read() {
    try {
      return StoreSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schedules: {} };
      throw error;
    }
  }
  private async write(store: z.infer<typeof StoreSchema>) {
    await mkdir(join(this.options.storageRoot, "schedules"), { recursive: true });
    await writeJsonFileAtomic(this.file, StoreSchema.parse(store));
  }
  list(): Promise<KitchenSchedule[]> {
    return this.serial(async () => Object.values((await this.read()).schedules));
  }
  save(input: z.infer<typeof KitchenScheduleSaveSchema>): Promise<KitchenSchedule> {
    return this.serial(async () => {
      const request = KitchenScheduleSaveSchema.parse(input);
      validateScheduleCadence(request.cadence);
      if (
        request.expiresAt !== undefined &&
        request.expiresAt !== null &&
        !Number.isFinite(Date.parse(request.expiresAt))
      )
        throw new Error("Invalid schedule expiry");
      const store = await this.read();
      const previous = request.id ? store.schedules[request.id] : undefined;
      if (request.id && !previous) throw new Error("Schedule not found");
      if (previous?.runs.some((run) => run.status === "running" || run.status === "retry"))
        throw new Error("Wait for the pending Kitchen kickoff before editing its schedule");
      const now = this.now();
      const schedule: KitchenSchedule = {
        id: previous?.id ?? `schedule_${randomBytes(6).toString("hex")}`,
        name: request.name,
        cadence: request.cadence,
        target: request.target,
        status: previous?.status ?? "active",
        createdAt: previous?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        nextRunAt: computeNextRunAt(request.cadence, now).toISOString(),
        maxRuns: request.maxRuns ?? null,
        expiresAt: request.expiresAt ?? null,
        runs: previous?.runs ?? [],
      };
      if (schedule.status !== "active") schedule.nextRunAt = null;
      store.schedules[schedule.id] = schedule;
      await this.write(store);
      return schedule;
    });
  }
  control(
    id: string,
    action: "pause" | "resume" | "run-once" | "delete",
    actorId: string,
  ): Promise<KitchenSchedule | null> {
    if (!actorId.trim()) return Promise.reject(new Error("A human actor is required"));
    if (action === "run-once") {
      const pending = this.manualRuns.get(id);
      if (pending) return pending;
      const run = this.serial(() => this.runOnce(id)).finally(() => this.manualRuns.delete(id));
      this.manualRuns.set(id, run);
      return run;
    }
    return this.serial(async () => {
      const store = await this.read();
      const schedule = store.schedules[id];
      if (!schedule) throw new Error("Schedule not found");
      if (action === "delete") {
        if (schedule.runs.some((run) => run.status === "running" || run.status === "retry"))
          throw new Error("Resolve the pending Kitchen kickoff before deleting its schedule");
        delete store.schedules[id];
        await this.write(store);
        return null;
      }
      schedule.status = action === "pause" ? "paused" : "active";
      schedule.updatedAt = this.now().toISOString();
      schedule.nextRunAt =
        action === "pause" ? null : computeNextRunAt(schedule.cadence, this.now()).toISOString();
      await this.write(store);
      return schedule;
    });
  }
  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return;
      const store = await this.read();
      for (const schedule of Object.values(store.schedules)) {
        if (this.stopped) return;
        const pending = schedule.runs.find(
          (run) => run.status === "running" || run.status === "retry",
        );
        if (pending) {
          if (!pending.retryAt || Date.parse(pending.retryAt) <= this.now().getTime())
            await this.execute(store, schedule, pending);
          continue;
        }
        if (schedule.status !== "active") continue;
        if (this.exhausted(schedule)) {
          schedule.status = "completed";
          schedule.nextRunAt = null;
          await this.write(store);
          continue;
        }
        if (schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= this.now().getTime()) {
          const run = this.reserve(schedule, schedule.nextRunAt, `due:${schedule.nextRunAt}`);
          schedule.nextRunAt = computeNextRunAt(schedule.cadence, this.now()).toISOString();
          await this.write(store);
          await this.execute(store, schedule, run);
        }
      }
    });
  }
  private exhausted(schedule: KitchenSchedule): boolean {
    return (
      (schedule.maxRuns !== null && schedule.runs.length >= schedule.maxRuns) ||
      (schedule.expiresAt !== null && Date.parse(schedule.expiresAt) <= this.now().getTime())
    );
  }
  private reserve(schedule: KitchenSchedule, scheduledFor: string, slot: string): ScheduleRun {
    const run: ScheduleRun = {
      slot,
      scheduledFor,
      startedAt: this.now().toISOString(),
      endedAt: null,
      status: "running",
      attempts: 0,
      retryAt: null,
      teamId: null,
      error: null,
      target: structuredClone(schedule.target),
    };
    schedule.runs.push(run);
    return run;
  }
  private async runOnce(id: string): Promise<KitchenSchedule> {
    const store = await this.read();
    const schedule = store.schedules[id];
    if (!schedule) throw new Error("Schedule not found");
    const pending = schedule.runs.find((run) => run.status === "running" || run.status === "retry");
    if (!pending && this.exhausted(schedule))
      throw new Error("Schedule has reached its run or expiry limit");
    const run =
      pending ??
      this.reserve(schedule, this.now().toISOString(), `manual:${schedule.runs.length + 1}`);
    await this.write(store);
    await this.execute(store, schedule, run);
    return schedule;
  }
  private async execute(
    store: z.infer<typeof StoreSchema>,
    schedule: KitchenSchedule,
    run: ScheduleRun,
  ): Promise<void> {
    run.status = "running";
    run.attempts += 1;
    run.retryAt = null;
    await this.write(store);
    try {
      const team = await this.options.service.startKitchen({
        ...run.target,
        scheduleId: schedule.id,
        idempotencyKey: `${schedule.id}:${run.slot}`,
      });
      run.status = "succeeded";
      run.teamId = team.team.id;
      run.endedAt = this.now().toISOString();
      run.error = null;
      if (this.exhausted(schedule)) {
        schedule.status = "completed";
        schedule.nextRunAt = null;
      }
    } catch (error) {
      run.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      if (run.attempts >= 3) {
        run.status = "failed";
        run.endedAt = this.now().toISOString();
        schedule.status = "paused";
        schedule.nextRunAt = null;
      } else {
        run.status = "retry";
        run.retryAt = new Date(
          this.now().getTime() + 60_000 * 2 ** (run.attempts - 1),
        ).toISOString();
      }
    }
    schedule.updatedAt = this.now().toISOString();
    await this.write(store);
  }
}

interface CronDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function startOfNextMinute(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes() + 1,
      0,
      0,
    ),
  );
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid cron time zone: ${timeZone}`);
  }
}

function createCronDatePartsReader(timeZone: string | undefined): (date: Date) => CronDateParts {
  if (timeZone === undefined) {
    return (date: Date) => ({
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    });
  }

  assertValidTimeZone(timeZone);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (date: Date) => {
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    }

    const year = Number.parseInt(values.year, 10);
    const month = Number.parseInt(values.month, 10);
    const dayOfMonth = Number.parseInt(values.day, 10);

    return {
      minute: Number.parseInt(values.minute, 10),
      hour: Number.parseInt(values.hour, 10),
      dayOfMonth,
      month,
      dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
    };
  };
}

export function validateScheduleCadence(cadence: ScheduleCadence): void {
  if (cadence.type === "cron") {
    parseCronExpression(cadence.expression);
    if (cadence.timezone !== undefined) {
      assertValidTimeZone(cadence.timezone);
    }
  }
}

export function computeNextRunAt(cadence: ScheduleCadence, after: Date): Date {
  if (cadence.type === "every") {
    return new Date(after.getTime() + cadence.everyMs);
  }

  const cron = parseCronExpression(cadence.expression);
  const readDateParts = createCronDatePartsReader(cadence.timezone);
  const limit = 366 * 24 * 60;
  let cursor = startOfNextMinute(after);

  for (let index = 0; index < limit; index += 1) {
    const { minute, hour, dayOfMonth, month, dayOfWeek } = readDateParts(cursor);

    if (
      cron.minute.matches(minute) &&
      cron.hour.matches(hour) &&
      cron.dayOfMonth.matches(dayOfMonth) &&
      cron.month.matches(month) &&
      cron.dayOfWeek.matches(dayOfWeek)
    ) {
      return cursor;
    }

    cursor = new Date(cursor.getTime() + 60_000);
  }

  throw new Error(`Unable to compute next run time for cron expression: ${cadence.expression}`);
}
