import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailVerificationConfirmation } from "./EmailVerificationConfirmation";

describe("EmailVerificationConfirmation", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("does not consume the token until the explicit Verify button is pressed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { email: "student@example.test" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<EmailVerificationConfirmation token="preview-safe-token" />);

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verify email" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Email verified successfully");
    expect(fetchMock).toHaveBeenCalledWith("/api/student/email/verify", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ token: "preview-safe-token" }),
    }));
  }, 15_000);

  it.each([
    ["network failure", () => Promise.reject(new TypeError("offline"))],
    ["non-JSON failure", () => Promise.resolve({
      ok: false,
      json: async () => Promise.reject(new SyntaxError("not json")),
    })],
  ])("surfaces a verification %s and restores the button", async (_, request) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(request));
    render(<EmailVerificationConfirmation token="retryable-token" />);

    fireEvent.click(screen.getByRole("button", { name: "Verify email" }));

    expect(await screen.findByText(
      "Unable to verify email. Check your connection and try again.",
    )).toBeVisible();
    expect(screen.getByRole("button", { name: "Verify email" })).toBeEnabled();
  }, 15_000);
});
