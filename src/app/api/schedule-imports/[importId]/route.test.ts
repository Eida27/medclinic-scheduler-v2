// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  requireUser,
  getScheduleImport,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getScheduleImport: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({
  getScheduleImport,
}));

import { GET } from "./route";

const importId = "11111111-1111-4111-8111-111111111111";
const admin = { userId: "admin-user", role: "ADMIN" as const };
const context = { params: Promise.resolve({ importId }) };

describe("/api/schedule-imports/[importId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    getScheduleImport.mockResolvedValue({ id: importId, status: "DRAFT" });
  });

  it("returns import detail to administrators and coordinators", async () => {
    const response = await GET(new Request(`http://localhost/api/schedule-imports/${importId}`), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { id: importId, status: "DRAFT" } });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    expect(getScheduleImport).toHaveBeenCalledWith(importId, admin);
  });

  it("enforces import-operator authorization for detail reads", async () => {
    requireUser.mockRejectedValue(new AppError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    ));

    const response = await GET(new Request(`http://localhost/api/schedule-imports/${importId}`), context);

    expect(response.status).toBe(403);
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    expect(getScheduleImport).not.toHaveBeenCalled();
  });
});
