// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, listAppointments } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listAppointments: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/appointments.repository", () => ({ listAppointments }));

import { GET } from "./route";

describe("GET /api/appointments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "staff-user", role: "CLINIC_STAFF" });
    listAppointments.mockResolvedValue({ items: [], total: 0 });
  });

  it("always requests published appointments even when the URL asks for drafts", async () => {
    const response = await GET(new Request(
      "http://localhost/api/appointments?isPublished=false&studentNumber=Ada&sort=surname_desc&page=2&limit=10",
    ));

    expect(response.status).toBe(200);
    expect(listAppointments).toHaveBeenCalledWith(expect.objectContaining({
      studentNumber: "Ada",
      sort: "surname_desc",
      isPublished: true,
      page: 2,
      limit: 10,
      offset: 10,
    }));
    await expect(response.json()).resolves.toEqual({
      data: { items: [], total: 0, page: 2, limit: 10 },
    });
  });

  it("falls back to soonest for an unsupported sort", async () => {
    const response = await GET(new Request(
      "http://localhost/api/appointments?sort=date_desc",
    ));

    expect(response.status).toBe(200);
    expect(listAppointments).toHaveBeenCalledWith(expect.objectContaining({ sort: "soonest" }));
  });
});
