import "server-only";
import type { ScheduleItemInput } from "./types";

export function sortByPriority(items: ScheduleItemInput[]): ScheduleItemInput[] {
  return [...items].sort(
    (left, right) =>
      left.priorityRank - right.priorityRank || left.studentNumber.localeCompare(right.studentNumber),
  );
}
