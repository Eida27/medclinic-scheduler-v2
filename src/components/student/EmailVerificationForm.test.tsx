import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailVerificationForm } from "./EmailVerificationForm";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

describe("EmailVerificationForm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("polls status every five seconds and continues the original onboarding session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { verified: true, verifiedEmail: "student@example.test" } }),
    }));
    render(<EmailVerificationForm verifiedEmail={null} />);

    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(fetch).toHaveBeenCalledWith("/api/student/email/status", { cache: "no-store" });
    expect(replace).toHaveBeenCalledWith("/student");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows server-provided cooldown timing after a request", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          expiresAt: "2026-08-22T01:30:00.000Z",
          resendAvailableAt: "2026-08-22T01:01:00.000Z",
        },
      }),
    }));
    render(<EmailVerificationForm verifiedEmail={null} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "student@example.test" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send verification link" }).closest("form")!);

    expect(await screen.findByRole("status")).toHaveTextContent(/resend available/i);
  });
});
