import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultDraftManager } from "./ResultDraftManager";
import type { StudentResultDraftView } from "./ResultDraftManager";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const approvedStaleMessage = "Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.";

const apiResponse = (
  ok = true,
  payload: unknown = { data: {} },
) => ({ ok, json: async () => payload });

const pdfFile = (name = "result.pdf", bytes = "%PDF-1.7") => (
  new File([bytes], name, { type: "application/pdf" })
);
const pngFile = (name = "scan.png") => (
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" })
);
const jpegFile = (name = "photo.jpeg") => (
  new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: "image/jpeg" })
);

const draft = (
  overrides: Partial<StudentResultDraftView> = {},
): StudentResultDraftView => ({
  id: "10000000-0000-4000-8000-000000000001",
  appointmentId: "appointment-1",
  resultType: "LABORATORY" as const,
  status: "DRAFT" as const,
  basedOnSubmissionId: null,
  fileCount: 0,
  totalBytes: 0,
  administratorReplacementReason: null,
  files: [] as Array<{ id: string; originalFilename: string; byteSize: number }>,
  ...overrides,
});

describe("ResultDraftManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows draft totals and a multiple result-file chooser", () => {
    render(<ResultDraftManager draft={draft({
      fileCount: 2,
      totalBytes: 3 * 1024 * 1024,
    })} />);

    expect(screen.getByText("2/10 files · 3.00 MB/50 MB")).toBeVisible();
    expect(screen.getByLabelText(/choose result files/i)).toHaveAttribute("multiple");
    expect(screen.getByRole("button", { name: "Upload files" })).toBeDisabled();
  });

  it("renders selected files and sends one multipart request with repeated files and the draft id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft()} />);
    const input = screen.getByLabelText(/choose result files/i) as HTMLInputElement;
    const pdf = pdfFile("laboratory.pdf");
    const png = pngFile("laboratory.png");

    await user.upload(input, [pdf, png]);
    expect(screen.getByText(pdf.name)).toBeVisible();
    expect(screen.getByText(png.name)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Upload files" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/student/result-submissions/appointment-1/files");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("submissionId")).toBe("10000000-0000-4000-8000-000000000001");
    expect(body.getAll("file").map((entry) => (entry as File).name)).toEqual([
      "laboratory.pdf",
      "laboratory.png",
    ]);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(input.files).toHaveLength(0);
  });

  it("shows selected-row errors and blocks every upload control for an invalid selection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultDraftManager draft={draft()} />);
    const input = screen.getByLabelText(/choose result files/i);

    fireEvent.change(input, {
      target: {
        files: [new File(["unsafe"], "unsafe.exe", { type: "application/octet-stream" })],
      },
    });

    const selectedRow = screen.getByText("unsafe.exe").closest("li")!;
    expect(within(selectedRow).getByText("Upload a PDF, JPG, JPEG, or PNG file.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a valid selection when its resulting file count exceeds ten", async () => {
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft({ fileCount: 10, totalBytes: 80 })} />);

    await user.upload(screen.getByLabelText(/choose result files/i), pdfFile());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "A result submission may contain at most 10 files.",
    );
    expect(screen.getByRole("button", { name: "Upload files" })).toBeDisabled();
  });

  it("preserves the selected files after a recoverable upload failure so retry sends them again", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse(false, {
        error: { code: "UPLOAD_FAILED", message: "The upload could not be saved." },
      }))
      .mockResolvedValueOnce(apiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft()} />);
    const input = screen.getByLabelText(/choose result files/i) as HTMLInputElement;
    await user.upload(input, [pdfFile(), pngFile()]);

    await user.click(screen.getByRole("button", { name: "Upload files" }));
    expect(await screen.findByText("The upload could not be saved.")).toBeVisible();
    expect(input.files).toHaveLength(2);
    expect(screen.getByText("result.pdf")).toBeVisible();
    expect(screen.getByText("scan.png")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Upload files" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1][1]?.body as FormData).getAll("file")).toHaveLength(2);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("uses a synchronous guard to prevent duplicate upload requests in one render tick", async () => {
    let resolveRequest!: (value: ReturnType<typeof apiResponse>) => void;
    const request = new Promise<ReturnType<typeof apiResponse>>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft()} />);
    const input = screen.getByLabelText(/choose result files/i);
    await user.upload(input, pdfFile());
    const form = input.closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveRequest(apiResponse());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("announces the number of files while a batch upload is pending", async () => {
    let resolveRequest!: (value: ReturnType<typeof apiResponse>) => void;
    const request = new Promise<ReturnType<typeof apiResponse>>((resolve) => {
      resolveRequest = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(request));
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft()} />);
    await user.upload(screen.getByLabelText(/choose result files/i), [
      pdfFile(),
      pngFile(),
      jpegFile(),
    ]);

    await user.click(screen.getByRole("button", { name: "Upload files" }));

    expect(screen.getByText("Uploading 3 files...")).toBeVisible();
    resolveRequest(apiResponse());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("shows submitted files as downloads and starts editing through the edit route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft({
      status: "FINALIZED",
      fileCount: 2,
      totalBytes: 12_400,
      files: [
        { id: "official-file-1", originalFilename: "submitted.pdf", byteSize: 6_000 },
        { id: "official-file-2", originalFilename: "submitted.png", byteSize: 6_400 },
      ],
    })} />);

    expect(screen.getByText("Submitted")).toBeVisible();
    expect(screen.getByText("2 files · 0.01 MB")).toBeVisible();
    expect(screen.getByRole("link", { name: /download submitted\.pdf/i })).toHaveAttribute(
      "href",
      "/api/student/result-files/official-file-1",
    );
    expect(screen.queryByLabelText(/choose result files/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit submission" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/student/result-submissions/appointment-1/edit",
      { method: "POST" },
    ));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("shows retained edit files and removes one with its expected edit id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft({
      basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
      fileCount: 1,
      totalBytes: 32,
      files: [{ id: "copied-file-1", originalFilename: "retained.pdf", byteSize: 32 }],
    })} />);

    expect(screen.getByText("Editing submission")).toBeVisible();
    expect(screen.getByText(
      "Your currently submitted result remains official until you submit these changes.",
    )).toBeVisible();
    expect(screen.getByText("retained.pdf")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Remove retained.pdf" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/student/result-submissions/appointment-1/files/copied-file-1",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: "10000000-0000-4000-8000-000000000001" }),
      },
    ));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("requires the exact discard confirmation before cancelling an edit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft({
      basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
      fileCount: 1,
    })} />);

    await user.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(screen.getByRole("dialog", { name: "Cancel editing?" })).toBeVisible();
    expect(screen.getByText(
      "Discard your changes? Your currently submitted result will remain unchanged.",
    )).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/student/result-submissions/appointment-1/edit",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: "10000000-0000-4000-8000-000000000001" }),
      },
    ));
  });

  it("confirms submit changes and exposes its pending state", async () => {
    let resolveRequest!: (value: ReturnType<typeof apiResponse>) => void;
    const request = new Promise<ReturnType<typeof apiResponse>>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(request);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft({
      basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
      fileCount: 1,
      files: [{ id: "copied-file-1", originalFilename: "retained.pdf", byteSize: 32 }],
    })} />);

    await user.click(screen.getByRole("button", { name: "Submit changes" }));
    expect(screen.getByRole("dialog", { name: "Submit these changes?" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", {
      name: "Submit changes",
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/student/result-submissions/appointment-1/submit-changes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: "10000000-0000-4000-8000-000000000001" }),
      },
    ));
    expect(screen.getByRole("button", { name: "Submitting changes..." })).toBeDisabled();
    resolveRequest(apiResponse());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("keeps submit changes unavailable when every edit file was removed", () => {
    render(<ResultDraftManager draft={draft({
      basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
    })} />);

    expect(screen.getByRole("button", { name: "Submit changes" })).toBeDisabled();
  });

  it("uses the approved confirmation copy and expected id for an initial final submit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={draft({
      fileCount: 1,
      files: [{ id: "file-1", originalFilename: "result.pdf", byteSize: 8 }],
    })} />);

    await user.click(screen.getByRole("button", { name: "Final submit" }));
    expect(screen.getByRole("dialog", { name: "Submit this result?" })).toBeVisible();
    expect(screen.getByText(
      "These files will become your submitted result. You can edit your submission later if corrections are needed.",
    )).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Submit result" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/student/result-submissions/appointment-1/finalize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: "10000000-0000-4000-8000-000000000001" }),
      },
    ));
  });

  it("shows the approved administrator-invalidation conflict and the replacement reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiResponse(false, {
      error: { code: "RESULT_EDIT_STALE", message: "This result draft changed. Refresh and try again." },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender } = render(<ResultDraftManager draft={draft({
      basedOnSubmissionId: "20000000-0000-4000-8000-000000000002",
      fileCount: 1,
      files: [{ id: "copied-file-1", originalFilename: "retained.pdf", byteSize: 32 }],
    })} />);
    await user.click(screen.getByRole("button", { name: "Submit changes" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", {
      name: "Submit changes",
    }));

    expect(await screen.findByText(approvedStaleMessage)).toBeVisible();
    expect(refresh).not.toHaveBeenCalled();

    rerender(<ResultDraftManager draft={draft({
      administratorReplacementReason: "The uploaded page belongs to another student.",
    })} />);
    expect(screen.getByText("The uploaded page belongs to another student.")).toBeVisible();
  });
});
