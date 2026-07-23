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

  it("uses Laboratory-specific labels and the submission-addressed API URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "lab-submission", status: "INVALIDATED" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminSubmissionActions submissionId="lab-submission" resultLabel="Laboratory" />);

    expect(screen.getByRole("link", { name: "Download Laboratory ZIP" })).toHaveAttribute(
      "href",
      "/api/admin/student-result-submissions/lab-submission/zip",
    );
    await user.type(screen.getByLabelText("Laboratory invalidation reason"), "Replacement needed");
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory and reopen upload" }));

    expect(screen.getByRole("dialog", { name: "Invalidate Laboratory submission?" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory submission" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/student-result-submissions/lab-submission/invalidate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "Replacement needed" }),
      }),
    ));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Invalidate Laboratory submission?" })).not.toBeInTheDocument();
  });

  it("shows an API conflict, closes stale confirmation state, and refreshes the profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: "RESULT_SUBMISSION_CONFLICT",
          message: "This finalized submission is stale and cannot be invalidated.",
        },
      }),
    }));
    const user = userEvent.setup();

    render(<AdminSubmissionActions submissionId="lab-submission" resultLabel="Laboratory" />);
    await user.type(screen.getByLabelText("Laboratory invalidation reason"), "Replacement needed");
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory and reopen upload" }));
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory submission" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This finalized submission is stale and cannot be invalidated.",
    );
    expect(screen.queryByRole("dialog", { name: "Invalidate Laboratory submission?" })).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("clears a stale API error before retrying invalidation", async () => {
    let resolveRetry!: (value: {
      ok: boolean;
      status: number;
      json: () => Promise<{ data: { id: string; status: string } }>;
    }) => void;
    const retry = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<{ data: { id: string; status: string } }>;
    }>((resolve) => { resolveRetry = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ error: { message: "Reason rejected." } }),
      })
      .mockReturnValueOnce(retry);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminSubmissionActions submissionId="lab-submission" resultLabel="Laboratory" />);
    await user.type(screen.getByLabelText("Laboratory invalidation reason"), "Replacement needed");
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory and reopen upload" }));
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory submission" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reason rejected.");

    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory submission" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    resolveRetry({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "lab-submission", status: "INVALIDATED" } }),
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("keeps Physical Exam labels unique", () => {
    render(<AdminSubmissionActions submissionId="exam-submission" resultLabel="Physical Exam" />);

    expect(screen.getByLabelText("Physical Exam invalidation reason")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download Physical Exam ZIP" })).toHaveAttribute(
      "href",
      "/api/admin/student-result-submissions/exam-submission/zip",
    );
    expect(screen.getByRole("button", { name: "Invalidate Physical Exam and reopen upload" })).toBeVisible();
    expect(screen.queryByLabelText("Laboratory invalidation reason")).not.toBeInTheDocument();
  });
});
