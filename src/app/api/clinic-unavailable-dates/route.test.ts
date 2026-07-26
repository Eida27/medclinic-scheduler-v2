// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, listClinicUnavailableDates, saveClinicCalendarChanges } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listClinicUnavailableDates: vi.fn(),
  saveClinicCalendarChanges: vi.fn(),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/clinic-calendar.service", () => ({
  listClinicUnavailableDates,
  saveClinicCalendarChanges,
}));

import { GET, POST } from "./route";

const admin = { userId: "admin-id", role: "ADMIN" as const };
const laboratoryClinicId = "60000000-0000-4000-8000-000000000001";
const physicalClinicId = "60000000-0000-4000-8000-000000000002";
const blockId = "70000000-0000-4000-8000-000000000001";
const body = {
  changes: [
    {
      action: "BLOCK",
      clinicId: laboratoryClinicId,
      date: "2027-07-15",
      category: "CLOSURE",
      reason: "Planned maintenance",
    },
    {
      action: "UNBLOCK",
      clinicId: physicalClinicId,
      date: "2027-08-04",
      unavailableDateId: blockId,
      expectedUpdatedAt: "2027-07-01T00:00:00.000Z",
    },
  ],
};

function postRequest(payload: unknown) {
  return new Request("http://localhost/api/clinic-unavailable-dates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("/api/clinic-unavailable-dates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    listClinicUnavailableDates.mockResolvedValue([]);
    saveClinicCalendarChanges.mockResolvedValue({
      batchId: "batch-id",
      activeUnavailableDates: [],
      blockedDateCount: 1,
      unblockedDateCount: 1,
      movedStudentCount: 2,
      movedAppointmentCount: 4,
      restoredStudentCount: 1,
      restoredAppointmentCount: 1,
    });
  });

  it("lists active records for administrators", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listClinicUnavailableDates).toHaveBeenCalledWith(admin);
  });

  it("submits one mixed batch and returns every movement count", async () => {
    const response = await POST(postRequest(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        batchId: "batch-id",
        activeUnavailableDates: [],
        blockedDateCount: 1,
        unblockedDateCount: 1,
        movedStudentCount: 2,
        movedAppointmentCount: 4,
        restoredStudentCount: 1,
        restoredAppointmentCount: 1,
      },
    });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(saveClinicCalendarChanges).toHaveBeenCalledWith(body, admin);
  });

  it("rejects malformed JSON as INVALID_JSON without calling the batch service", async () => {
    const response = await POST(new Request("http://localhost/api/clinic-unavailable-dates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_JSON",
        message: "The request body must be valid JSON.",
      },
    });
    expect(saveClinicCalendarChanges).not.toHaveBeenCalled();
  });

  it.each([
    ["empty changes", { changes: [] }],
    [
      "duplicate clinic date changes",
      {
        changes: [body.changes[0], { ...body.changes[0], reason: "Another reason" }],
      },
    ],
  ])("returns VALIDATION_ERROR for %s", async (_label, invalidBody) => {
    saveClinicCalendarChanges.mockRejectedValueOnce(new AppError(
      "VALIDATION_ERROR",
      "Please correct the highlighted fields.",
      422,
      undefined,
      { issues: [{ code: "INVALID_CHANGE", date: "", clinicId: "", action: "BLOCK" }] },
    ));

    const response = await POST(postRequest(invalidBody));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: { issues: [{ code: "INVALID_CHANGE" }] },
      },
    });
    expect(saveClinicCalendarChanges).toHaveBeenCalledWith(invalidBody, admin);
  });

  it.each([
    ["past date", { ...body.changes[0], date: "2025-07-15" }],
    ["weekend date", { ...body.changes[0], date: "2027-07-17" }],
  ])("passes through date-specific batch rejection for a %s", async (_label, change) => {
    const issue = {
      clinicId: change.clinicId,
      date: change.date,
      action: change.action,
      code: "INVALID_CHANGE",
      message: "Clinic calendar dates must be future weekdays.",
    };
    saveClinicCalendarChanges.mockRejectedValueOnce(new AppError(
      "CLINIC_CALENDAR_BATCH_REJECTED",
      "No calendar changes were saved.",
      409,
      undefined,
      { issues: [issue] },
    ));

    const invalidBody = { changes: [change] };
    const response = await POST(postRequest(invalidBody));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "CLINIC_CALENDAR_BATCH_REJECTED",
        details: { issues: [issue] },
      },
    });
  });

  it("passes through structured domain issues", async () => {
    const issues = [{
      clinicId: physicalClinicId,
      date: "2027-08-04",
      action: "UNBLOCK",
      code: "STALE_BLOCK",
      message: "Refresh and try again.",
    }];
    saveClinicCalendarChanges.mockRejectedValueOnce(new AppError(
      "CLINIC_CALENDAR_BATCH_REJECTED",
      "No calendar changes were saved.",
      409,
      undefined,
      { issues },
    ));

    const response = await POST(postRequest(body));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "CLINIC_CALENDAR_BATCH_REJECTED",
        details: { issues },
      },
    });
  });

  it("returns every date-specific capacity issue in a rejected batch", async () => {
    const capacityBody = {
      changes: [
        {
          action: "BLOCK",
          clinicId: laboratoryClinicId,
          date: "2028-07-03",
          category: "CLOSURE",
          reason: "Laboratory capacity dependency",
        },
        {
          action: "BLOCK",
          clinicId: physicalClinicId,
          date: "2028-07-04",
          category: "MAINTENANCE",
          reason: "Physical capacity dependency",
        },
      ],
    };
    const issues = capacityBody.changes.map((change) => ({
      clinicId: change.clinicId,
      date: change.date,
      action: change.action,
      code: "CAPACITY_CONFLICT",
      message: "Both clinic capacity settings are required before editing the clinic calendar.",
    }));
    saveClinicCalendarChanges.mockRejectedValueOnce(new AppError(
      "CLINIC_CALENDAR_BATCH_REJECTED",
      "No calendar changes were saved.",
      409,
      undefined,
      { issues },
    ));

    const response = await POST(postRequest(capacityBody));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "CLINIC_CALENDAR_BATCH_REJECTED",
        details: { issues },
      },
    });
  });

  it("requires authentication for POST", async () => {
    requireUser.mockRejectedValueOnce(new AppError("UNAUTHORIZED", "Authentication required.", 401));

    const response = await POST(postRequest(body));

    expect(response.status).toBe(401);
    expect(saveClinicCalendarChanges).not.toHaveBeenCalled();
  });

  it("requires an administrator for GET", async () => {
    requireUser.mockRejectedValueOnce(new AppError("FORBIDDEN", "Forbidden", 403));

    const response = await GET();

    expect(response.status).toBe(403);
    expect(listClinicUnavailableDates).not.toHaveBeenCalled();
  });
});
