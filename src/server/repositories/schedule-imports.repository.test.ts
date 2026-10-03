import { describe, expect, it } from "vitest";
import { deriveScheduleImportStatus } from "./schedule-imports.repository";

describe("current Schedule Import status", () => {
  it.each(["PUBLISHED", "CANCELLED"])("returns synchronized current children %s", status => {
    expect(deriveScheduleImportStatus([status, status])).toBe(status);
  });
  it.each([["DRAFT", "DRAFT"], ["VALIDATED", "VALIDATED"], ["GENERATED", "GENERATED"], ["PUBLISHED", "CANCELLED"], [], ["UNKNOWN"]].map(statuses => ({ statuses })))("flags unsupported or inconsistent children $statuses", ({ statuses }) => {
    expect(deriveScheduleImportStatus(statuses)).toBe("NEEDS_REVIEW");
  });
});
