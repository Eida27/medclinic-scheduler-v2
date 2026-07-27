import { describe, expect, it } from "vitest";
import type { ClinicCalendarChange } from "@/types/clinic-calendar";
import {
  calendarDraftKey,
  resolveCalendarDateState,
  summarizeCalendarDraft,
  toggleCalendarDraft,
} from "./clinic-calendar-draft";

const persisted = {
  id: "70000000-0000-4000-8000-000000000001",
  closureGroupId: "71000000-0000-4000-8000-000000000001",
  blockedDate: "2027-08-11",
  groupStartDate: "2027-08-11",
  groupEndDate: "2027-08-13",
  category: "CLOSURE" as const,
  reason: "Typhoon",
  createdByName: "Admin",
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-01-01T00:00:00.000000Z",
};

describe("date-only annual calendar drafts", () => {
  it("uses the ISO date itself as the stable cross-month and cross-year key", () => {
    expect(calendarDraftKey("2027-08-11")).toBe("2027-08-11");
    expect(calendarDraftKey("2028-01-02")).toBe("2028-01-02");
  });

  it("stages BLOCK and REOPEN without clinicId or UNBLOCK", () => {
    let draft = new Map<string, ClinicCalendarChange>();
    draft = toggleCalendarDraft(draft, {
      date: "2027-08-12",
      blockTemplate: { category: "MAINTENANCE", reason: "  Annual   check " },
    });
    draft = toggleCalendarDraft(draft, {
      persisted,
      date: persisted.blockedDate,
      blockTemplate: { category: "CLOSURE", reason: "Unused" },
    });
    expect([...draft.values()]).toEqual([
      { action: "BLOCK", date: "2027-08-12", category: "MAINTENANCE", reason: "Annual check" },
      {
        action: "REOPEN",
        date: "2027-08-11",
        unavailableDateId: persisted.id,
        expectedUpdatedAt: persisted.updatedAt,
      },
    ]);
    expect(JSON.stringify([...draft.values()])).not.toContain("clinicId");
    expect(summarizeCalendarDraft(draft)).toEqual({ blockedDateCount: 1, reopenedDateCount: 1 });
    expect(resolveCalendarDateState({ date: persisted.blockedDate, persisted, draft }).state).toBe("STAGED_REOPEN");
  });
});
