import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSubmissionActions } from "./AdminSubmissionActions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("AdminSubmissionActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires the application confirmation dialog before invalidating", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminSubmissionActions submissionId="submission-1" />);
    await user.type(screen.getByLabelText("Invalidation reason"), "Replacement needed");
    await user.click(screen.getByRole("button", { name: "Invalidate and reopen upload" }));

    expect(screen.getByRole("dialog", { name: "Invalidate this submission?" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Invalidate submission" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/student-result-submissions/submission-1/invalidate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "Replacement needed" }),
      }),
    ));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
