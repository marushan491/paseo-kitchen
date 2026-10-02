import { appendFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { withStorageLock } from "./storage-lock.js";
import { type TeamEvent, TeamEventSchema, type TeamState, TeamStateSchema } from "./types.js";

export type TeamEventDraft = Omit<TeamEvent, "id" | "commit" | "at">;

export class StaleRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRevisionError";
  }
}

export class TeamStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private teamDir(teamId: string): string {
    if (!/^team_[A-Za-z0-9_-]+$/.test(teamId)) throw new Error("Invalid team ID");
    return join(this.dir, teamId);
  }

  async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && /^team_[A-Za-z0-9_-]+$/.test(e.name))
        .map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(teamId: string): Promise<TeamState | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.teamDir(teamId), "state.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const state = TeamStateSchema.parse(JSON.parse(raw));
    return structuredClone(state);
  }

  async events(teamId: string): Promise<TeamEvent[]> {
    try {
      const state = await this.get(teamId);
      if (!state) return [];
      const raw = await readFile(join(this.teamDir(teamId), "events.jsonl"), "utf8");
      return this.committedEvents(teamId, raw, state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async create(state: TeamState, events: TeamEventDraft[]): Promise<void> {
    await withStorageLock(`${this.teamDir(state.team.id)}.lock`, async () => {
      if (await this.get(state.team.id)) throw new Error(`Team ${state.team.id} already exists`);
      await mkdir(this.teamDir(state.team.id), { recursive: true });
      await this.write(state.team.id, { ...state, commit: 0, eventCount: 0 }, events);
    });
  }

  commit<T>(
    teamId: string,
    mutate: (
      draft: TeamState,
    ) => { events: TeamEventDraft[]; result: T } | Promise<{ events: TeamEventDraft[]; result: T }>,
  ): Promise<T> {
    const previous = this.chains.get(teamId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() =>
        withStorageLock(`${this.teamDir(teamId)}.lock`, async () => {
          const draft = await this.get(teamId);
          if (!draft) throw new Error(`Team ${teamId} not found`);
          await this.dropUncommittedEvents(teamId, draft);
          const before = JSON.stringify(draft);
          const { events, result } = await mutate(draft);
          if (events.length || JSON.stringify(draft) !== before)
            await this.write(teamId, draft, events);
          return result;
        }),
      );
    this.chains.set(teamId, next);
    return next;
  }

  private async write(teamId: string, state: TeamState, events: TeamEventDraft[]): Promise<void> {
    const commit = state.commit + 1;
    const eventCount = state.eventCount ?? (await this.events(teamId)).length;
    const at = new Date().toISOString();
    if (events.length > 0) {
      const lines = events.map((e) => JSON.stringify({ ...e, commit, at })).join("\n") + "\n";
      const path = join(this.teamDir(teamId), "events.jsonl");
      await appendFile(path, lines);
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const next = { ...state, commit, eventCount: eventCount + events.length };
    await writeJsonFileAtomic(join(this.teamDir(teamId), "state.json"), next);
  }

  private async dropUncommittedEvents(teamId: string, state: TeamState): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(join(this.teamDir(teamId), "events.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const kept = this.committedEvents(teamId, raw, state);
    if (kept.length === raw.split("\n").filter(Boolean).length) return;
    await writeFile(
      join(this.teamDir(teamId), "events.jsonl"),
      kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
    );
  }
  private committedEvents(teamId: string, raw: string, state: TeamState): TeamEvent[] {
    const lines = raw.split("\n").filter(Boolean);
    if (state.eventCount !== undefined && lines.length < state.eventCount)
      throw new Error("Kitchen committed event journal is truncated");
    const committed = state.eventCount === undefined ? lines : lines.slice(0, state.eventCount);
    return committed
      .map((line, position) =>
        TeamEventSchema.parse({ ...JSON.parse(line), id: `${teamId}:${position}` }),
      )
      .filter((event) => {
        if (state.eventCount !== undefined && event.commit > state.commit)
          throw new Error("Kitchen event journal contradicts its committed state");
        return event.commit <= state.commit;
      });
  }
}
