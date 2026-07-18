// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, createClinicUnavailableDate, listClinicUnavailableDates } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createClinicUnavailableDate: vi.fn(),
  listClinicUnavailableDates: vi.fn(),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/clinic-calendar.service", () => ({
  createClinicUnavailableDate,
  listClinicUnavailableDates,
}));

import { GET, POST } from "./route";

const admin = { userId: "admin-id", role: "ADMIN" as const };

describe("/api/clinic-unavailable-dates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    listClinicUnavailableDates.mockResolvedValue([]);
    createClinicUnavailableDate.mockResolvedValue({
      id: "block-id",
      movedStudentCount: 2,
      movedAppointmentCount: 4,
    });
  });

  it("lists blocks for administrators", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listClinicUnavailableDates).toHaveBeenCalledWith(admin);
  });

  it("creates an atomic block from JSON input", async () => {
    const body = {
      clinicId: "60000000-0000-4000-8000-000000000001",
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      category: "CLOSURE",
      reason: "Planned maintenance",
    };
    const response = await POST(new Request("http://localhost/api/clinic-unavailable-dates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: { id: "block-id", movedStudentCount: 2, movedAppointmentCount: 4 },
    });
    expect(createClinicUnavailableDate).toHaveBeenCalledWith(body, admin);
  });

  it("is admin-only", async () => {
    requireUser.mockRejectedValue(new AppError("FORBIDDEN", "Forbidden", 403));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(listClinicUnavailableDates).not.toHaveBeenCalled();
  });
});
