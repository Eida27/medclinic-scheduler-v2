import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  CalendarDraftChange,
  ClinicCalendarBlockChange,
  ClinicCalendarCategory,
  ClinicCalendarUnblockChange,
} from "@/types/clinic-calendar";

export type CalendarDateState =
  | { state: "AVAILABLE" }
  | { state: "SAVED_BLOCKED"; record: ClinicUnavailableDateRecord }
  | { state: "STAGED_BLOCK"; change: ClinicCalendarBlockChange }
  | { state: "STAGED_UNBLOCK"; record: ClinicUnavailableDateRecord; change: ClinicCalendarUnblockChange }
  | { state: "CONFLICT"; messages: string[] };

type CalendarBlockTemplate = {
  category: ClinicCalendarCategory;
  reason: string;
};

type ToggleCalendarDraftInput = {
  persisted: ClinicUnavailableDateRecord | undefined;
  clinicId: string;
  date: string;
  blockTemplate: CalendarBlockTemplate;
};

type ResolveCalendarDateStateInput = {
  clinicId: string;
  date: string;
  persisted: ClinicUnavailableDateRecord | undefined;
  draft: Map<string, CalendarDraftChange>;
  conflictMessages?: string[];
};

export function calendarDraftKey(clinicId: string, date: string) {
  return `${clinicId}:${date}`;
}

export function toggleCalendarDraft(
  draft: Map<string, CalendarDraftChange>,
  { persisted, clinicId, date, blockTemplate }: ToggleCalendarDraftInput,
): Map<string, CalendarDraftChange> {
  const key = calendarDraftKey(clinicId, date);
  const next = new Map(draft);

  if (next.has(key)) {
    next.delete(key);
    return next;
  }

  if (persisted) {
    next.set(key, {
      action: "UNBLOCK",
      clinicId,
      date,
      unavailableDateId: persisted.id,
      expectedUpdatedAt: persisted.updatedAt,
    });
    return next;
  }

  next.set(key, {
    action: "BLOCK",
    clinicId,
    date,
    category: blockTemplate.category,
    reason: blockTemplate.reason,
  });
  return next;
}

export function summarizeCalendarDraft(draft: Map<string, CalendarDraftChange>) {
  let blockedDateCount = 0;
  let unblockedDateCount = 0;

  for (const change of draft.values()) {
    if (change.action === "BLOCK") {
      blockedDateCount += 1;
    } else {
      unblockedDateCount += 1;
    }
  }

  return { blockedDateCount, unblockedDateCount };
}

export function resolveCalendarDateState({
  clinicId,
  date,
  persisted,
  draft,
  conflictMessages,
}: ResolveCalendarDateStateInput): CalendarDateState {
  if (conflictMessages?.length) {
    return { state: "CONFLICT", messages: conflictMessages };
  }

  const change = draft.get(calendarDraftKey(clinicId, date));
  if (change?.action === "BLOCK") {
    return { state: "STAGED_BLOCK", change };
  }
  if (change?.action === "UNBLOCK" && persisted) {
    return { state: "STAGED_UNBLOCK", record: persisted, change };
  }
  if (persisted) {
    return { state: "SAVED_BLOCKED", record: persisted };
  }
  return { state: "AVAILABLE" };
}
