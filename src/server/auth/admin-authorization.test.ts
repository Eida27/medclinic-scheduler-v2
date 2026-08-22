import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), optionalStudent: vi.fn() }));
vi.mock("./current-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("./current-student", () => ({ optionalStudent: mocks.optionalStudent }));

import { requireAdministrator } from "./admin-authorization";

describe("requireAdministrator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the existing administrator role check", async () => {
    const admin = { userId: "admin", role: "ADMIN" };
    mocks.requireUser.mockResolvedValue(admin);
    await expect(requireAdministrator()).resolves.toBe(admin);
    expect(mocks.requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(mocks.optionalStudent).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated student session", async () => {
    mocks.requireUser.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in", 401));
    mocks.optionalStudent.mockResolvedValue({ studentNumber: "24-0001" });
    await expect(requireAdministrator()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("preserves 401 for an anonymous request and 403 for a coordinator", async () => {
    const unauthenticated = new AppError("UNAUTHENTICATED", "Sign in", 401);
    mocks.requireUser.mockRejectedValueOnce(unauthenticated);
    mocks.optionalStudent.mockResolvedValueOnce(null);
    await expect(requireAdministrator()).rejects.toBe(unauthenticated);

    const forbidden = new AppError("FORBIDDEN", "Administrators only", 403);
    mocks.requireUser.mockRejectedValueOnce(forbidden);
    await expect(requireAdministrator()).rejects.toBe(forbidden);
  });
});
