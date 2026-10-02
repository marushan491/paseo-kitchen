import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { preferencesSchema, type Preferences } from "../../shared/dashboard/contracts.js";

export type { Preferences } from "../../shared/dashboard/contracts.js";

export class PreferenceStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error("Dashboard data directory must be absolute");
  }
  async read(): Promise<Preferences> {
    try {
      return preferencesSchema.parse(
        JSON.parse(await readFile(join(this.directory, "preferences.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { snoozedUntil: {}, doneAt: {} };
      throw new Error("Dashboard preferences could not be read", { cause: error });
    }
  }
  update(change: (current: Preferences) => Preferences): Promise<Preferences> {
    const operation = this.queue.catch(() => undefined).then(() => this.persist(change));
    this.queue = operation;
    return operation;
  }
  private async persist(change: (current: Preferences) => Preferences): Promise<Preferences> {
    const next = preferencesSchema.parse(change(await this.read()));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, "preferences.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, target);
    return next;
  }
}
