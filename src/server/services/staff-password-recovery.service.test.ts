import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, transaction } = vi.hoisted(() => {
  const queryMock = vi.fn();
  return {
    query: queryMock,
    transaction: vi.fn(async (callback: (client: { query: typeof queryMock }) => Promise<unknown>) => callback({ query: queryMock })),
  };
});

vi.mock("@/server/db/pool", () => ({ query: vi.fn(), transaction }));
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

import { resetStaffPassword } from "./staff-password-recovery.service";

describe("resetStaffPassword token validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it("rejects an invalid token before performing an expensive password hash", async () => {
    await expect(resetStaffPassword({
      token: "invalid-reset-token",
      newPassword: "ReplacementPassword123!",
      confirmPassword: "ReplacementPassword123!",
    })).rejects.toMatchObject({ code: "STAFF_PASSWORD_RESET_INVALID", status: 422 });

    expect(bcrypt.hash).not.toHaveBeenCalled();
  });
});
