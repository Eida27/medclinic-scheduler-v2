import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { getStaffOnboardingState, redirect, requireAuthenticatedStaff } = vi.hoisted(() => ({
  getStaffOnboardingState: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }),
  requireAuthenticatedStaff: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/auth/current-user", () => ({ requireAuthenticatedStaff }));
vi.mock("@/server/services/staff-account-security.service", () => ({ getStaffOnboardingState }));
vi.mock("@/components/account/OnboardingPanel", () => ({
  OnboardingPanel: () => <div>Onboarding controls</div>,
}));

import AccountOnboardingPage from "./page";

describe("AccountOnboardingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthenticatedStaff.mockResolvedValue({ userId: "staff-1", onboardingRequired: true });
    getStaffOnboardingState.mockResolvedValue({});
  });

  it("renders onboarding for a current authenticated session", async () => {
    render(await AccountOnboardingPage());
    expect(screen.getByText("Onboarding controls")).toBeVisible();
  });

  it.each(["SESSION_EXPIRED", "UNAUTHENTICATED"])(
    "redirects the known %s authentication failure to sign in",
    async (code) => {
      requireAuthenticatedStaff.mockRejectedValue(new AppError(code, "Please sign in.", 401));
      await expect(AccountOnboardingPage()).rejects.toThrow("REDIRECT:/login");
      expect(redirect).toHaveBeenCalledWith("/login");
      expect(getStaffOnboardingState).not.toHaveBeenCalled();
    },
  );

  it("keeps unexpected operational failures visible", async () => {
    const failure = new AppError("DATABASE_UNAVAILABLE", "Database unavailable.", 500);
    requireAuthenticatedStaff.mockRejectedValue(failure);
    await expect(AccountOnboardingPage()).rejects.toBe(failure);
    expect(redirect).not.toHaveBeenCalled();
  });
});
