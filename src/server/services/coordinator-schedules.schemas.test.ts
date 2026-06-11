import { describe, expect, it } from "vitest";
import { createBatchSchema } from "./coordinator-schedules.service";

const base = {
  batchName: "Engineering July 2026",
  collegeId: "10000000-0000-4000-8000-000000000003",
  programId: "20000000-0000-4000-8000-000000000003",
  submittedByName: "Coordinator",
  description: "",
  items: [{
    studentNumber: "DEMO-0001",
    scheduleType: "BOTH",
    priorityGroupId: "30000000-0000-4000-8000-000000000001",
    targetDate: "2026-07-20",
    targetWeekStart: null,
    targetWeekEnd: null,
    remarks: "",
  }],
};

describe("createBatchSchema", () => {
  it("accepts a BOTH item with one exact date", () => {
    expect(createBatchSchema.parse(base).items[0].scheduleType).toBe("BOTH");
  });

  it("rejects an item that supplies both an exact date and a target week", () => {
    const invalid = structuredClone(base);
    invalid.items[0].targetWeekStart = "2026-07-20";
    invalid.items[0].targetWeekEnd = "2026-07-24";
    expect(() => createBatchSchema.parse(invalid)).toThrow();
  });

  it("rejects duplicate student and schedule-type pairs", () => {
    expect(() => createBatchSchema.parse({ ...base, items: [base.items[0], base.items[0]] })).toThrow();
  });
});
