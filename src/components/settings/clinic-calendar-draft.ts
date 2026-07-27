import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  ClinicCalendarBlockChange,
  ClinicCalendarCategory,
  ClinicCalendarChange,
  ClinicCalendarReopenChange,
} from "@/types/clinic-calendar";

export type CalendarDateState =
  | { state: "AVAILABLE" }
  | { state: "SAVED_BLOCKED"; record: ClinicUnavailableDateRecord }
  | { state: "STAGED_BLOCK"; change: ClinicCalendarBlockChange }
  | { state: "STAGED_REOPEN"; record: ClinicUnavailableDateRecord; change: ClinicCalendarReopenChange }
  | { state: "CONFLICT"; messages: string[] };

export function calendarDraftKey(date: string) {
  return date;
}

export function toggleCalendarDraft(
  draft: Map<string, ClinicCalendarChange>,
  input: {
    persisted?: ClinicUnavailableDateRecord;
    date: string;
    blockTemplate: { category: ClinicCalendarCategory; reason: string };
  },
) {
  const next = new Map(draft);
  if (next.has(input.date)) {
    next.delete(input.date);
  } else if (input.persisted) {
    next.set(input.date, {
      action: "REOPEN",
      date: input.date,
      unavailableDateId: input.persisted.id,
      expectedUpdatedAt: input.persisted.updatedAt,
    });
  } else {
    next.set(input.date, {
      action: "BLOCK",
      date: input.date,
      category: input.blockTemplate.category,
      reason: input.blockTemplate.reason.trim().replace(/\s+/g, " "),
    });
  }
  return next;
}

export function summarizeCalendarDraft(draft: Map<string, ClinicCalendarChange>) {
  const values = [...draft.values()];
  return {
    blockedDateCount: values.filter((change) => change.action === "BLOCK").length,
    reopenedDateCount: values.filter((change) => change.action === "REOPEN").length,
  };
}

export function resolveCalendarDateState(input: {
  date: string;
  persisted?: ClinicUnavailableDateRecord;
  draft: Map<string, ClinicCalendarChange>;
  conflictMessages?: string[];
}): CalendarDateState {
  if (input.conflictMessages?.length) return { state: "CONFLICT", messages: input.conflictMessages };
  const change = input.draft.get(input.date);
  if (change?.action === "BLOCK") return { state: "STAGED_BLOCK", change };
  if (change?.action === "REOPEN" && input.persisted) {
    return { state: "STAGED_REOPEN", record: input.persisted, change };
  }
  if (input.persisted) return { state: "SAVED_BLOCKED", record: input.persisted };
  return { state: "AVAILABLE" };
}
