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
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("explains that verification gates Laboratory changes while reading remains available", () => {
    render(<EmailVerificationForm verifiedEmail={null} />);
    expect(screen.getByText(
      "Verify your email to upload or update Laboratory documents. You can still view schedules, notifications, and existing results.",
    )).toBeVisible();
  });

  it("polls status every five seconds and continues the original onboarding session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { verified: true, verifiedEmail: "student@example.test" } }),
    }));
    render(<EmailVerificationForm verifiedEmail={null} returnTo="/student/results" />);

    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(fetch).toHaveBeenCalledWith("/api/student/email/status", { cache: "no-store" });
    expect(replace).toHaveBeenCalledWith("/student/results");
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops polling on a non-JSON 401 and provides sign-in navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false,
      json: async () => { throw new SyntaxError("not json"); },
    }));
    render(<EmailVerificationForm verifiedEmail={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/student/login");
    expect(screen.getByRole("button", { name: "Send verification link" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("retries transient status errors without requesting mail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { verified: true } }) }));
    render(<EmailVerificationForm verifiedEmail={null} />);
    expect(screen.getByRole("link", { name: "Back to schedule" })).toHaveAttribute("href", "/student");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(replace).toHaveBeenCalledWith("/student");
    for (const [url] of vi.mocked(fetch).mock.calls) expect(url).toBe("/api/student/email/status");
  });

  it("allows only one status request in flight and ignores completion after unmount", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
    const { unmount } = render(<EmailVerificationForm verifiedEmail={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { resolve({ ok: true, json: async () => ({ data: { verified: true } }) }); });
    expect(replace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("retains replacement-email behavior without polling for a verified address", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<EmailVerificationForm verifiedEmail="verified@example.test" />);
    expect(screen.getByLabelText("Replacement email")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows server-provided cooldown timing after a request", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          message: "Please wait before requesting another verification email.",
          details: { retryAfterSeconds: 54 },
        },
      }),
    }));
    render(<EmailVerificationForm verifiedEmail={null} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "student@example.test" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send verification link" }).closest("form")!);

    expect(await screen.findByText(/try again in 54 seconds/i)).toBeVisible();
  }, 15_000);

  it.each([
    ["network failure", () => Promise.reject(new TypeError("offline"))],
    ["non-JSON failure", () => Promise.resolve({
      ok: false,
      json: async () => Promise.reject(new SyntaxError("not json")),
    })],
  ])("surfaces a request %s and restores the form", async (_, request) => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(request));
    render(<EmailVerificationForm verifiedEmail="verified@example.test" />);
    fireEvent.change(screen.getByLabelText("Replacement email"), {
      target: { value: "replacement@example.test" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Send verification link" }).closest("form")!);

    expect(await screen.findByText(
      "Unable to request verification. Check your connection and try again.",
    )).toBeVisible();
    expect(screen.getByRole("button", { name: "Send verification link" })).toBeEnabled();
  }, 15_000);

  it("clears the status polling interval when onboarding unmounts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { verified: false } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<EmailVerificationForm verifiedEmail={null} />);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
