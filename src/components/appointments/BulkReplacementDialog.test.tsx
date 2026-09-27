import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { BulkReplacementDialog } from "./BulkReplacementDialog";

afterEach(() => vi.unstubAllGlobals());

describe("BulkReplacementDialog", () => {
  it("shows each student's preview conflict and requires another preview after removal", async () => {
    const onRemove = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {
      rows: [
        { id: "row-1", studentNumber: "BULK-0001", originalDate: "2026-09-25",
          pairedDate: "2026-10-05", retainedTests: [], isManuallyLocked: false,
          issues: [{ code: "BULK_SOURCE_CHANGED", message: "An appointment changed. Preview the selection again." }] },
        { id: "row-2", studentNumber: "BULK-0002", originalDate: "2026-09-25",
          pairedDate: "2026-10-05", retainedTests: [], isManuallyLocked: true, issues: [] },
      ],
      capacity: { used: 0, incoming: 2, resulting: 2, maximum: 2 },
      service: "LABORATORY", academicYearStart: 2026, previewToken: null,
    } }) }));
    render(<BulkReplacementDialog selected={[
      { id: "row-1", expectedUpdatedAt: "2026-09-25T00:00:00.000Z" },
      { id: "row-2", expectedUpdatedAt: "2026-09-25T00:00:00.000Z" },
    ]} onRemove={onRemove} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Replacement date"), { target: { value: "2026-09-28" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Schedule adjustment" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview conflicts and capacity" }));
    expect(await screen.findByText(/An appointment changed/)).toBeVisible();
    expect(screen.getByText(/BULK-0002/)).toBeVisible();
    expect(screen.getByText(/0 used \+ 2 incoming = 2 \/ 2/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save all replacements" })).toBeDisabled();
    const conflictedStudent = screen.getByText("BULK-0001").closest("li");
    expect(conflictedStudent).not.toBeNull();
    fireEvent.click(within(conflictedStudent!).getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith("row-1");
    await waitFor(() => expect(screen.queryByText(/An appointment changed/)).not.toBeInTheDocument());
  });
});
