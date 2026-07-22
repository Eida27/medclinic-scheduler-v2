import { describe, expect, it } from "vitest";
import { generatePairedSchedule } from "./generate-paired-schedule";
import type { PairedScheduleRequest } from "./types";

function request(overrides: Partial<PairedScheduleRequest> = {}): PairedScheduleRequest {
  return {
    requestId: "request-1",
    studentNumber: "23-0001-01",
    category: "REGULAR",
    acceptedAt: "2026-07-01T00:00:00.000Z",
    sourceRowOrder: 1,
    windowStart: "2026-08-07",
    ...overrides,
  };
}

function generate(requests: PairedScheduleRequest[], overrides: Record<string, unknown> = {}) {
  return generatePairedSchedule({
    requests,
    laboratoryCapacity: { maxDailyCapacity: 2 },
    physicalExamCapacity: { maxDailyCapacity: 2 },
    existingLaboratoryLoad: {},
    existingPhysicalExamLoad: {},
    blockedLaboratoryDates: [],
    blockedPhysicalExamDates: [],
    searchEndDate: "2027-06-30",
    ...overrides,
  });
}

describe("generatePairedSchedule", () => {
  it("fills each clinic date to its maximum before moving to the next date", () => {
    const result = generatePairedSchedule({
      requests: [
        request({ requestId: "first" }),
        request({ requestId: "second", studentNumber: "23-0002-02", sourceRowOrder: 2 }),
        request({ requestId: "third", studentNumber: "23-0003-03", sourceRowOrder: 3 }),
      ],
      laboratoryCapacity: { maxDailyCapacity: 2 },
      physicalExamCapacity: { maxDailyCapacity: 2 },
      existingLaboratoryLoad: {},
      existingPhysicalExamLoad: {},
      blockedLaboratoryDates: [],
      blockedPhysicalExamDates: [],
      searchEndDate: "2026-08-11",
    });

    expect(result.assignments.map((assignment) => assignment.laboratoryDate)).toEqual([
      "2026-08-07",
      "2026-08-07",
      "2026-08-10",
    ]);
    expect(result.assignments.map((assignment) => assignment.physicalExamDate)).toEqual([
      "2026-08-10",
      "2026-08-10",
      "2026-08-11",
    ]);
  });

  it("pairs a Friday Laboratory appointment with the following Monday PE", () => {
    const result = generate([request()]);
    expect(result.assignments).toEqual([expect.objectContaining({
      requestId: "request-1",
      laboratoryDate: "2026-08-07",
      physicalExamDate: "2026-08-10",
      schedulePairId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })]);
  });

  it("skips clinic-specific blocked dates", () => {
    const result = generate([request()], {
      blockedLaboratoryDates: ["2026-08-07"],
      blockedPhysicalExamDates: ["2026-08-11"],
    });
    expect(result.assignments[0]).toMatchObject({
      laboratoryDate: "2026-08-10",
      physicalExamDate: "2026-08-12",
    });
  });

  it("orders priority tier first, then accepted time, row order, and student number", () => {
    const requests = [
      request({ requestId: "regular", studentNumber: "23-0004-04", category: "REGULAR" }),
      request({ requestId: "later-priority", studentNumber: "23-0003-03", category: "OJT", acceptedAt: "2026-07-02T00:00:00.000Z" }),
      request({ requestId: "row-two", studentNumber: "23-0002-02", category: "TOUR", sourceRowOrder: 2 }),
      request({ requestId: "row-one-b", studentNumber: "23-0001-02", category: "SPECIALIZED" }),
      request({ requestId: "row-one-a", studentNumber: "23-0001-01", category: "OJT" }),
    ];
    expect(generate(requests).assignments.map((assignment) => assignment.requestId)).toEqual([
      "row-one-a",
      "row-one-b",
      "row-two",
      "later-priority",
      "regular",
    ]);
  });

  it("continues Regular allocation beyond March", () => {
    const result = generate([
      request({ requestId: "first", windowStart: "2027-03-31" }),
      request({ requestId: "second", studentNumber: "23-0002-02", sourceRowOrder: 2, windowStart: "2027-03-31" }),
    ]);
    expect(result.assignments).toEqual([
      expect.objectContaining({ requestId: "first", laboratoryDate: "2027-03-31", physicalExamDate: "2027-04-01" }),
      expect.objectContaining({ requestId: "second", laboratoryDate: "2027-03-31", physicalExamDate: "2027-04-01" }),
    ]);
  });

  it("does not reserve a Laboratory slot unless the complete pair fits", () => {
    const result = generate([request({ windowStart: "2026-08-07" })], {
      searchEndDate: "2026-08-07",
    });
    expect(result).toEqual({ assignments: [], unscheduledRequestIds: ["request-1"] });
  });

  it("uses maximum capacity as the sole ceiling", () => {
    const maximumFull = generate([request()], {
      laboratoryCapacity: { maxDailyCapacity: 1 },
      existingLaboratoryLoad: { "2026-08-07": 1 },
      searchEndDate: "2026-08-11",
    });
    expect(maximumFull.assignments[0].laboratoryDate).toBe("2026-08-10");
  });
});
