import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPanel } from "./OnboardingPanel";
import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { ResetPasswordForm } from "./ResetPasswordForm";
import { AccountSecurityPanel } from "./AccountSecurityPanel";
import { StaffEmailVerificationConfirm } from "./StaffEmailVerificationConfirm";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  replace.mockReset();
  refresh.mockReset();
});

describe("staff security screens", () => {
  it("consumes an email verification token only once in React Strict Mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { mustChangePassword: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StrictMode><StaffEmailVerificationConfirm token="verification-token" /></StrictMode>);

    expect(await screen.findByText(/Email verified/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows an actionable error when email verification cannot reach the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<StaffEmailVerificationConfirm token="unreachable-token" />);

    expect(await screen.findByText(/Unable to verify your email right now/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue to Login" })).toBeVisible();
  });

  it("shows an onboarding-only warning with ordered verification and password steps", () => {
    render(<OnboardingPanel initialState={{
      emailMasked: "pe*****@example.test",
      emailVerified: false,
      mustChangePassword: true,
      status: "PENDING_VERIFICATION",
      resendAvailableAt: new Date(0).toISOString(),
      retryAfterSeconds: 0,
    }} />);
    expect(screen.getByRole("heading", { name: "Secure your account before continuing." })).toBeVisible();
    const steps = screen.getAllByRole("heading", { level: 2 });
    expect(steps.map((step) => step.textContent)).toEqual([
      "1. Verify your email",
      "2. Replace temporary password",
    ]);
    expect(screen.getByLabelText("Current temporary password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Dashboard navigation" })).not.toBeInTheDocument();
  });

  it("reenables verification resend when the server-provided cooldown elapses", () => {
    vi.useFakeTimers();
    try {
      render(<OnboardingPanel initialState={{
        emailMasked: "pe*****@example.test",
        emailVerified: false,
        mustChangePassword: true,
        status: "PENDING_VERIFICATION",
        resendAvailableAt: new Date(Date.now() + 2_000).toISOString(),
        retryAfterSeconds: 2,
      }} />);
      const resend = screen.getByRole("button", { name: "Resend verification" });
      expect(resend).toBeDisabled();
      act(() => vi.advanceTimersByTime(2_000));
      expect(resend).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the generic Forgot Password response regardless of account eligibility", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { accepted: true } }) }));
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText("Email address"), "unknown@example.test");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText("If an eligible account exists for that email, a password reset message has been sent.")).toBeVisible();
  });

  it("submits reset confirmation and sends the user back to Login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { reset: true, nextPath: "/login" } }) }));
    const user = userEvent.setup();
    render(<ResetPasswordForm token="reset-token" />);
    await user.type(screen.getByLabelText("New password"), "Recovered123!");
    await user.type(screen.getByLabelText("Confirm new password"), "Recovered123!");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("shows read-only account identity and changes the current browser password", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { nextPath: "/account" } }) }));
    const user = userEvent.setup();
    render(<AccountSecurityPanel account={{
      id: "user-1",
      fullName: "Schedule Coordinator",
      email: "coordinator@example.test",
      role: "COORDINATOR",
      clinicName: null,
      emailVerified: true,
      status: "ACTIVE",
    }} />);
    expect(screen.getByText("Schedule Coordinator")).toBeVisible();
    expect(screen.getByText("coordinator@example.test")).toBeVisible();
    await user.type(screen.getByLabelText("Current password"), "Operational123!");
    await user.type(screen.getByLabelText("New password"), "ChangedPassword123!");
    await user.type(screen.getByLabelText("Confirm new password"), "ChangedPassword123!");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("recovers the account password form after a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();
    render(<AccountSecurityPanel account={{
      id: "user-1",
      fullName: "Schedule Coordinator",
      email: "coordinator@example.test",
      role: "COORDINATOR",
      clinicName: null,
      emailVerified: true,
      status: "ACTIVE",
    }} />);
    await user.type(screen.getByLabelText("Current password"), "Operational123!");
    await user.type(screen.getByLabelText("New password"), "ChangedPassword123!");
    await user.type(screen.getByLabelText("Confirm new password"), "ChangedPassword123!");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to change the password.");
    expect(screen.getByRole("button", { name: "Change password" })).toBeEnabled();
  });
});
