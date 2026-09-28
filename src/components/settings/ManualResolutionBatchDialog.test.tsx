import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ManualResolutionBatchDialog } from "./ManualResolutionBatchDialog";

afterEach(() => vi.unstubAllGlobals());

it("requires a reviewed preview and invalidates it when the reason changes", async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/availability")) return Promise.resolve(new Response(JSON.stringify({ data: {
      month: "2026-10", service: "LABORATORY", required: 1, days: [{ date: "2026-10-05", state: "AVAILABLE", issues: [], capacity: [{ clinicId: "c", used: 0, maximum: 5, available: 5, required: 1, projected: 1 }] }],
    } }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ data: {
      rows: [{ caseId: "one", studentNumber: "24-0001", laboratory: { oldDate: "2026-09-01", newDate: "2026-10-05", action: "MOVE" }, physicalExam: null, retainedTests: [], issues: [] }],
      capacity: [], studentCount: 1, appointmentCount: 1, expiresAt: "2026-10-01T00:00:00Z", previewToken: "proof",
    } }), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ManualResolutionBatchDialog cases={[{ caseId: "one", expectedOptimisticToken: "token", studentNumber: "24-0001", academicYearStart: 2026, needsLaboratory: true, needsPhysicalExam: false, hasLaboratory: true, hasPhysicalExam: false }]}
    onClose={vi.fn()} onResolved={vi.fn()} initialMonth="2026-10" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /2026-10-05.*Available/ }));
  await user.type(screen.getByLabelText("Batch resolution reason"), "Reviewed together");
  await user.click(screen.getByRole("checkbox", { name: /I reviewed any services/ }));
  await user.click(screen.getByRole("button", { name: "Preview assignments" }));
  expect(await screen.findByText(/1 student.*1 replacement appointment/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Confirm assignments" })).toBeEnabled();
  await user.type(screen.getByLabelText("Batch resolution reason"), " today");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm assignments" })).not.toBeInTheDocument());
});

it("restores focus to the opener when the inline batch dialog closes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
    month: "2026-10", service: "PHYSICAL_EXAM", required: 0, days: [],
  } }), { status: 200 })));
  const opener = document.createElement("button");
  opener.textContent = "Open batch";
  document.body.append(opener);
  opener.focus();
  const onClose = vi.fn();
  const { unmount } = render(<ManualResolutionBatchDialog cases={[]} onClose={onClose} onResolved={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Assign schedules to selected cases" })).not.toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  await userEvent.setup().keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});
