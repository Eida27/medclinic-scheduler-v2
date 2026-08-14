// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const body = {
  requestId: "90000000-0000-4000-8000-000000000001",
  emergencyAcknowledged: false,
  recoveryMode: "AUTO_ELIGIBLE",
  changes: [
    { action: "BLOCK", date: "2027-07-15", category: "CLOSURE", reason: "Planned maintenance" },
    {
      action: "REOPEN",
      date: "2027-08-04",
      unavailableDateId: "70000000-0000-4000-8000-000000000001",
      expectedUpdatedAt: "2027-07-01T00:00:00.000000Z",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue(admin);
  listClinicUnavailableDates.mockResolvedValue([]);
  saveClinicCalendarChanges.mockResolvedValue({ requestId: body.requestId, activeUnavailableDates: [] });
});

describe("/api/clinic-unavailable-dates", () => {
  it("allows administrators and clinic staff to read the unified calendar", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(listClinicUnavailableDates).toHaveBeenCalledWith(admin);
  });

  it("passes the exact date-only operation body to the service", async () => {
    const response = await POST(new Request("http://local/api/clinic-unavailable-dates", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(saveClinicCalendarChanges).toHaveBeenCalledWith(body, admin);
    expect(JSON.stringify(body)).not.toContain("clinicId");
    expect(JSON.stringify(body)).not.toContain("UNBLOCK");
  });

  it("rejects malformed JSON before calling the service", async () => {
    const response = await POST(new Request("http://local/api/clinic-unavailable-dates", {
      method: "POST",
      body: "{",
    }));
    expect(response.status).toBe(400);
    expect(saveClinicCalendarChanges).not.toHaveBeenCalled();
  });
});
