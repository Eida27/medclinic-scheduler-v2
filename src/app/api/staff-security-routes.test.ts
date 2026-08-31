// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const {
  setCookie,
  requireUser,
  requireAuthenticatedStaff,
  requestStaffPasswordReset,
  resetStaffPassword,
  replaceStaffTemporaryPassword,
  changeStaffPassword,
  getStaffOnboardingState,
  deleteStaffUser,
  authenticate,
} = vi.hoisted(() => ({
  setCookie: vi.fn(),
  requireUser: vi.fn(),
  requireAuthenticatedStaff: vi.fn(),
  requestStaffPasswordReset: vi.fn(),
  resetStaffPassword: vi.fn(),
  replaceStaffTemporaryPassword: vi.fn(),
  changeStaffPassword: vi.fn(),
  getStaffOnboardingState: vi.fn(),
  deleteStaffUser: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: setCookie })) }));
vi.mock("@/server/auth/current-user", () => ({ requireUser, requireAuthenticatedStaff }));
vi.mock("@/server/services/staff-password-recovery.service", () => ({
  requestStaffPasswordReset,
  resetStaffPassword,
}));
vi.mock("@/server/services/staff-account-security.service", () => ({
  replaceStaffTemporaryPassword,
  changeStaffPassword,
  getStaffOnboardingState,
}));
vi.mock("@/server/services/staff-administration.service", () => ({ deleteStaffUser }));
vi.mock("@/server/services/auth.service", () => ({ authenticate }));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/auth/session")>(),
  createSessionToken: vi.fn(async () => "fresh-session-token"),
}));

import { POST as forgotPassword } from "./auth/forgot-password/route";
import { POST as staffLogin } from "./auth/login/route";
import { POST as resetPassword } from "./auth/reset-password/route";
import { GET as onboardingState } from "./account/onboarding/route";
import { POST as replaceTemporaryPassword } from "./account/onboarding/replace-temporary-password/route";
import { POST as changePassword } from "./account/change-password/route";
import { DELETE as deleteUser } from "./users/[id]/route";

const session = {
  userId: "00000000-0000-4000-8000-000000000001",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  credentialVersion: 2,
  clinicId: null,
  clinicCode: null,
  clinicName: null,
};

const oversizedEmail = `${"a".repeat(308)}@example.test`;

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue(session);
  requireAuthenticatedStaff.mockResolvedValue(session);
});

describe("staff security API contracts", () => {
  it("forwards the parsed email and client IP while preserving the successful login contract", async () => {
    const user = { ...session, emailVerifiedAt: "2026-08-31T00:00:00.000Z", mustChangePassword: false, status: "ACTIVE", onboardingRequired: false };
    authenticate.mockResolvedValue(user);

    const response = await staffLogin(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.70, 10.0.0.4" },
      body: JSON.stringify({ email: "Admin@medclinic.local", password: "Admin123!" }),
    }));

    expect(authenticate).toHaveBeenCalledWith("Admin@medclinic.local", "Admin123!", "198.51.100.70");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ...user, nextPath: "/dashboard" } });
    expect(setCookie).toHaveBeenCalledWith("medclinic_session", "fresh-session-token", {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 28800,
      path: "/",
    });
  });

  it("mirrors staff throttle retry timing without issuing a session cookie", async () => {
    authenticate.mockRejectedValue(new AppError(
      "STAFF_LOGIN_THROTTLED",
      "Too many sign-in attempts. Try again later.",
      429,
      undefined,
      { retryAfterSeconds: 417 },
    ));

    const response = await staffLogin(new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "admin@medclinic.local", password: "Admin123!" }),
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("417");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "STAFF_LOGIN_THROTTLED",
        message: "Too many sign-in attempts. Try again later.",
        details: { retryAfterSeconds: 417 },
      },
    });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("rejects a staff email longer than 254 characters before authentication", async () => {
    expect(oversizedEmail).toHaveLength(321);
    authenticate.mockResolvedValue({
      ...session,
      emailVerifiedAt: "2026-08-31T00:00:00.000Z",
      mustChangePassword: false,
      status: "ACTIVE",
      onboardingRequired: false,
    });

    const response = await staffLogin(new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: oversizedEmail, password: "Admin123!" }),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("returns the same accepted response for Forgot Password", async () => {
    requestStaffPasswordReset.mockResolvedValue({ accepted: true });
    const response = await forgotPassword(new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: "unknown@example.test" }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { accepted: true } });
  });

  it("consumes reset input without issuing a session cookie", async () => {
    resetStaffPassword.mockResolvedValue({ userId: "user", credentialVersion: 4 });
    const response = await resetPassword(new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: "token", newPassword: "NewPassword123!", confirmPassword: "NewPassword123!" }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { reset: true, nextPath: "/login" } });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("allows restricted sessions to read onboarding state", async () => {
    getStaffOnboardingState.mockResolvedValue({ status: "PENDING_VERIFICATION" });
    const response = await onboardingState();
    expect(requireAuthenticatedStaff).toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ data: { status: "PENDING_VERIFICATION" } });
  });

  it("issues a replacement cookie after temporary-password replacement and ordinary change", async () => {
    replaceStaffTemporaryPassword.mockResolvedValue({ ...session, credentialVersion: 3, status: "ACTIVE" });
    const replaceResponse = await replaceTemporaryPassword(new Request("http://localhost/api/account/onboarding/replace-temporary-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: "Temporary123!", newPassword: "NewPassword123!", confirmPassword: "NewPassword123!" }),
    }));
    expect(replaceResponse.status).toBe(200);
    expect(setCookie).toHaveBeenCalledWith("medclinic_session", "fresh-session-token", expect.objectContaining({ httpOnly: true }));

    changeStaffPassword.mockResolvedValue({ ...session, credentialVersion: 4, status: "ACTIVE" });
    const changeResponse = await changePassword(new Request("http://localhost/api/account/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: "NewPassword123!", newPassword: "ChangedPassword123!", confirmPassword: "ChangedPassword123!" }),
    }));
    expect(changeResponse.status).toBe(200);
    expect(setCookie).toHaveBeenCalledTimes(2);
  });

  it("tombstones the target through DELETE /api/users/[id]", async () => {
    deleteStaffUser.mockResolvedValue({ deleted: true, id: "00000000-0000-4000-8000-000000000099" });
    const response = await deleteUser(
      new Request("http://localhost/api/users/00000000-0000-4000-8000-000000000099", { method: "DELETE" }),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000099" }) },
    );
    expect(deleteStaffUser).toHaveBeenCalledWith(session.userId, "00000000-0000-4000-8000-000000000099");
    expect(response.status).toBe(200);
  });
});
