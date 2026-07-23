import { render, screen, waitFor, within } from "@testing-library/react";
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

    render(<AdminSubmissionActions
      submissionId="lab-submission"
      resultLabel="Laboratory"
      appointmentDate="2026-08-18"
    />);

    expect(screen.getByRole("link", {
      name: "Download Laboratory ZIP for appointment 2026-08-18, submission 1",
    })).toHaveAttribute(
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

    render(<AdminSubmissionActions submissionId="lab-submission" resultLabel="Laboratory" appointmentDate="2026-08-18" />);
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

    render(<AdminSubmissionActions submissionId="lab-submission" resultLabel="Laboratory" appointmentDate="2026-08-18" />);
    await user.type(screen.getByLabelText("Laboratory invalidation reason"), "Replacement needed");
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory and reopen upload" }));
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory submission" }));
    const dialog = screen.getByRole("dialog", { name: "Invalidate Laboratory submission?" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Reason rejected.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory submission" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    resolveRetry({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "lab-submission", status: "INVALIDATED" } }),
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("recovers from a rejected request and allows the confirmation to be retried", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: "lab-submission", status: "INVALIDATED" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminSubmissionActions submissionId="lab-submission" resultLabel="Laboratory" appointmentDate="2026-08-18" />);
    await user.type(screen.getByLabelText("Laboratory invalidation reason"), "Replacement needed");
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory and reopen upload" }));
    await user.click(screen.getByRole("button", { name: "Invalidate Laboratory submission" }));

    const dialog = screen.getByRole("dialog", { name: "Invalidate Laboratory submission?" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Unable to invalidate this submission.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Invalidate Laboratory submission" })).toBeEnabled();

    await user.click(within(dialog).getByRole("button", { name: "Invalidate Laboratory submission" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Invalidate Laboratory submission?" })).not.toBeInTheDocument();
  });

  it("keeps Physical Exam labels unique", () => {
    render(<AdminSubmissionActions
      submissionId="exam-submission"
      resultLabel="Physical Exam"
      appointmentDate="2026-08-19"
    />);

    expect(screen.getByLabelText("Physical Exam invalidation reason")).toBeVisible();
    expect(screen.getByRole("link", {
      name: "Download Physical Exam ZIP for appointment 2026-08-19, submission 1",
    })).toHaveAttribute(
      "href",
      "/api/admin/student-result-submissions/exam-submission/zip",
    );
    expect(screen.getByRole("button", { name: "Invalidate Physical Exam and reopen upload" })).toBeVisible();
    expect(screen.queryByLabelText("Laboratory invalidation reason")).not.toBeInTheDocument();
  });
});
