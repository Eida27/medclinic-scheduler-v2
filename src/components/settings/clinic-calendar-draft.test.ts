import { describe, expect, it } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import type { CalendarDraftChange, ClinicCalendarCategory } from "@/types/clinic-calendar";
import {
  calendarDraftKey,
  resolveCalendarDateState,
  summarizeCalendarDraft,
  toggleCalendarDraft,
} from "./clinic-calendar-draft";

const savedBlock: ClinicUnavailableDateRecord = {
  id: "unavailable-1",
  clinicId: "clinic-a",
  clinicCode: "CLINIC_A",
  clinicName: "Clinic A",
  startDate: "2027-07-16",
  endDate: "2027-07-16",
  category: "CLOSURE",
  reason: "Inventory",
  createdByName: "Clinic Admin",
  createdAt: "2027-07-01T00:00:00.000Z",
  updatedAt: "2027-07-01T00:00:00.123456Z",
};

describe("toggleCalendarDraft", () => {
  it("stages a new block and cancels it on a second click", () => {
    let draft = new Map<string, CalendarDraftChange>();
    draft = toggleCalendarDraft(draft, {
      persisted: undefined,
      clinicId: "clinic-a",
      date: "2027-07-15",
      blockTemplate: { category: "MAINTENANCE", reason: "Equipment service" },
    });
    expect(draft.get(calendarDraftKey("clinic-a", "2027-07-15"))).toMatchObject({
      action: "BLOCK",
      category: "MAINTENANCE",
      reason: "Equipment service",
    });

    const cancelled = toggleCalendarDraft(draft, {
      persisted: undefined,
      clinicId: "clinic-a",
      date: "2027-07-15",
      blockTemplate: { category: "HOLIDAY", reason: "Changed later" },
    });
    expect(cancelled).not.toBe(draft);
    expect(draft.size).toBe(1);
    expect(cancelled.size).toBe(0);
  });

  it("stages an unblock with the saved record identity and cancels it on a second click", () => {
    const staged = toggleCalendarDraft(new Map(), {
      persisted: savedBlock,
      clinicId: "clinic-a",
      date: "2027-07-16",
      blockTemplate: { category: "HOLIDAY", reason: "Ignored" },
    });
    expect(staged.get(calendarDraftKey("clinic-a", "2027-07-16"))).toEqual({
      action: "UNBLOCK",
      clinicId: "clinic-a",
      date: "2027-07-16",
      unavailableDateId: "unavailable-1",
      expectedUpdatedAt: "2027-07-01T00:00:00.123456Z",
    });

    expect(toggleCalendarDraft(staged, {
      persisted: savedBlock,
      clinicId: "clinic-a",
      date: "2027-07-16",
      blockTemplate: { category: "HOLIDAY", reason: "Ignored" },
    }).size).toBe(0);
  });

  it("copies block details at selection time instead of retaining the form object", () => {
    const blockTemplate: { category: ClinicCalendarCategory; reason: string } = {
      category: "MAINTENANCE",
      reason: "Equipment service",
    };
    const draft = toggleCalendarDraft(new Map(), {
      persisted: undefined,
      clinicId: "clinic-a",
      date: "2027-07-15",
      blockTemplate,
    });
    blockTemplate.category = "HOLIDAY";
    blockTemplate.reason = "Changed later";

    expect(draft.get(calendarDraftKey("clinic-a", "2027-07-15"))).toMatchObject({
      category: "MAINTENANCE",
      reason: "Equipment service",
    });
  });
});

describe("calendar draft summary and displayed state", () => {
  it("keeps cross-clinic staged changes distinct in the summary", () => {
    const draft = new Map<string, CalendarDraftChange>([
      [calendarDraftKey("clinic-a", "2027-07-15"), {
        action: "BLOCK", clinicId: "clinic-a", date: "2027-07-15", category: "CLOSURE", reason: "Audit",
      }],
      [calendarDraftKey("clinic-b", "2027-07-15"), {
        action: "BLOCK", clinicId: "clinic-b", date: "2027-07-15", category: "HOLIDAY", reason: "Foundation day",
      }],
      [calendarDraftKey("clinic-a", "2027-08-01"), {
        action: "UNBLOCK", clinicId: "clinic-a", date: "2027-08-01", unavailableDateId: "unavailable-2", expectedUpdatedAt: "token",
      }],
    ]);

    expect(summarizeCalendarDraft(draft)).toEqual({
      blockedDateCount: 2,
      unblockedDateCount: 1,
    });
  });

  it("derives conflict, staged, saved, and available states without modifying the draft", () => {
    const draft = new Map<string, CalendarDraftChange>([
      [calendarDraftKey("clinic-a", "2027-07-15"), {
        action: "BLOCK", clinicId: "clinic-a", date: "2027-07-15", category: "CLOSURE", reason: "Audit",
      }],
      [calendarDraftKey("clinic-a", "2027-07-16"), {
        action: "UNBLOCK", clinicId: "clinic-a", date: "2027-07-16", unavailableDateId: "unavailable-1", expectedUpdatedAt: savedBlock.updatedAt,
      }],
    ]);

    expect(resolveCalendarDateState({
      clinicId: "clinic-a", date: "2027-07-15", persisted: undefined, draft,
    })).toMatchObject({ state: "STAGED_BLOCK" });
    expect(resolveCalendarDateState({
      clinicId: "clinic-a", date: "2027-07-16", persisted: savedBlock, draft,
    })).toMatchObject({ state: "STAGED_UNBLOCK", record: savedBlock });
    expect(resolveCalendarDateState({
      clinicId: "clinic-a", date: "2027-07-17", persisted: savedBlock, draft,
    })).toEqual({ state: "SAVED_BLOCKED", record: savedBlock });
    expect(resolveCalendarDateState({
      clinicId: "clinic-b", date: "2027-07-17", persisted: undefined, draft,
      conflictMessages: ["Capacity conflict"],
    })).toEqual({ state: "CONFLICT", messages: ["Capacity conflict"] });
    expect(draft.size).toBe(2);
  });
});
