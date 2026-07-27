// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, previewClinicCalendarChanges } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  previewClinicCalendarChanges: vi.fn(),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/clinic-calendar.service", () => ({ previewClinicCalendarChanges }));

import { POST } from "./route";

describe("/api/clinic-unavailable-dates/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin", role: "ADMIN" });
    previewClinicCalendarChanges.mockResolvedValue({ affectedStudentCount: 2 });
  });

  it("previews without changing the submitted operation contract", async () => {
    const body = {
      requestId: "90000000-0000-4000-8000-000000000001",
      emergencyAcknowledged: true,
      changes: [{ action: "BLOCK", date: "2027-07-15", category: "EMERGENCY_CLOSURE", reason: "Typhoon" }],
    };
    const response = await POST(new Request("http://local/api/clinic-unavailable-dates/preview", {
      method: "POST",
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    expect(previewClinicCalendarChanges).toHaveBeenCalledWith(body, expect.objectContaining({ role: "ADMIN" }));
  });
});
