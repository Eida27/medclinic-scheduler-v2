import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailVerificationConfirmation } from "./EmailVerificationConfirmation";

describe("EmailVerificationConfirmation", () => {
  beforeEach(() => vi.resetAllMocks());

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
  });
});
