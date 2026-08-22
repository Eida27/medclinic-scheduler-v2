import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), dashboardMetrics: vi.fn() }));
vi.mock("@/server/auth/current-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/repositories/tracking.repository", () => ({ dashboardMetrics: mocks.dashboardMetrics }));

import { GET } from "./route";

describe("dashboard API email-delivery count visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dashboardMetrics.mockResolvedValue({ totalStudents: 1 });
  });

  it("requests the actionable count for administrators", async () => {
    mocks.requireUser.mockResolvedValue({ userId: "admin", role: "ADMIN" });
    const response = await GET(new Request("http://localhost/api/dashboard"));
    expect(response.status).toBe(200);
    expect(mocks.dashboardMetrics).toHaveBeenCalledWith({
      clinicCode: undefined,
      includeEmailDeliveryIssues: true,
    });
  });

  it.each(["COORDINATOR", "CLINIC_STAFF"])("does not request or expose the count for %s", async (role) => {
    mocks.requireUser.mockResolvedValue({ userId: role, role });
    await GET(new Request("http://localhost/api/dashboard"));
    expect(mocks.dashboardMetrics).toHaveBeenCalledWith({
      clinicCode: undefined,
      includeEmailDeliveryIssues: false,
    });
  });
});
