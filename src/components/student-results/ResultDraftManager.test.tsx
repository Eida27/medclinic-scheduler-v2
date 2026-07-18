import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultDraftManager } from "./ResultDraftManager";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("ResultDraftManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("resets the captured upload form and refreshes after an async upload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { fileId: "file-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={{
      appointmentId: "appointment-1",
      resultType: "LABORATORY",
      status: "DRAFT",
      fileCount: 0,
      totalBytes: 0,
      files: [],
    }} />);
    const input = screen.getByLabelText("Result file") as HTMLInputElement;
    await user.upload(input, new File(["%PDF-1.7"], "result.pdf", { type: "application/pdf" }));
    expect(input.files).toHaveLength(1);
    const form = input.closest("form")!;
    const reset = vi.spyOn(form, "reset");
    fireEvent.submit(form);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(reset).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("requires the application confirmation dialog before finalizing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ResultDraftManager draft={{
      appointmentId: "appointment-1",
      resultType: "LABORATORY",
      status: "DRAFT",
      fileCount: 1,
      totalBytes: 8,
      files: [{ id: "file-1", originalFilename: "result.pdf", byteSize: 8 }],
    }} />);

    await user.click(screen.getByRole("button", { name: "Final submit" }));
    expect(screen.getByRole("dialog", { name: "Finalize this submission?" })).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Finalize submission" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/student/result-submissions/appointment-1/finalize",
      { method: "POST" },
    ));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
