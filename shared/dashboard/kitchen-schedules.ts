import type { KitchenSchedule } from "../factory-contracts.js";

export function visibleKitchenSchedules(schedules: KitchenSchedule[], problemsOnly: boolean) {
  return schedules
    .filter((schedule) => {
      if (!problemsOnly) return true;
      const last = schedule.runs.at(-1);
      return last?.status === "failed" || (last?.status === "retry" && Boolean(last.error));
    })
    .slice()
    .sort((left, right) => {
      const leftTime = left.nextRunAt || left.runs.at(-1)?.startedAt || left.createdAt;
      const rightTime = right.nextRunAt || right.runs.at(-1)?.startedAt || right.createdAt;
      return leftTime.localeCompare(rightTime);
    });
}
