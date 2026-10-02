import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

export async function withStorageLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `Kitchen storage is locked: ${path}. Stop its other writer; after a crashed writer, remove this lock only while all Kitchen runtimes are stopped.`,
          { cause: error },
        );
      await setTimeout(25);
    }
  }
  try {
    await writeFile(
      `${path}/owner.json`,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
export async function acquireRuntimeOwnership(directory: string): Promise<() => Promise<void>> {
  const path = `${directory}/runtime-owner.lock`;
  await mkdir(directory, { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    throw new Error(
      "Another Kitchen runtime owns this storage. After a crashed runtime, stop every Kitchen instance before removing runtime-owner.lock.",
      { cause: error },
    );
  }
  try {
    await writeFile(
      `${path}/owner.json`,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(path, { recursive: true, force: true });
  };
}
