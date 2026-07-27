// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { requireUser, listClinicClosureManualCases } = vi.hoisted(() => ({
  requireUser: vi.fn().mockResolvedValue({ userId: "admin", role: "ADMIN" }),
  listClinicClosureManualCases: vi.fn().mockResolvedValue({ total: 0, items: [] }),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/clinic-calendar.service", () => ({ listClinicClosureManualCases }));

import { GET } from "./route";

describe("manual-case API", () => {
  it("passes pagination and filters to the administrator service", async () => {
    const response = await GET(new Request("http://local/api/clinic-unavailable-dates/manual-cases?page=2&pageSize=10&search=2026&reasonCode=NO_REPLACEMENT_CAPACITY&closureGroupId=81000000-0000-4000-8000-000000000001&date=2026-08-18&service=LABORATORY"));
    expect(response.status).toBe(200);
    expect(listClinicClosureManualCases).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      search: "2026",
      reasonCode: "NO_REPLACEMENT_CAPACITY",
      status: undefined,
      closureGroupId: "81000000-0000-4000-8000-000000000001",
      date: "2026-08-18",
      service: "LABORATORY",
    }, expect.objectContaining({ role: "ADMIN" }));
  });
});
