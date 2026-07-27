import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualResolutionQueue } from "./ManualResolutionQueue";

const manualCase = {
  id: "80000000-0000-4000-8000-000000000001",
  studentNumber: "24-0001",
  studentName: "Santos, Ana M.",
  closureGroupId: "81000000-0000-4000-8000-000000000001",
  groupStartDate: "2026-08-18",
  groupEndDate: "2026-08-19",
  category: "MAINTENANCE",
  closureReason: "Generator testing",
  reasonCode: "NO_REPLACEMENT_CAPACITY",
  reasonMessage: "No safe paired dates remain.",
  status: "OPEN",
  optimisticToken: "82000000-0000-4000-8000-000000000001",
  createdAt: "2026-07-27T01:00:00.000Z",
  resolvedAt: null,
  resolutionAction: null,
  resolutionDetails: null,
  laboratory: { id: "lab-1", date: "2026-08-18", status: "AWAITING_RESCHEDULE" },
  physicalExam: { id: "pe-1", date: "2026-08-19", status: "AWAITING_RESCHEDULE" },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ManualResolutionQueue", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads searchable closure cases with dates, service state, and history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {
      page: 1,
      pageSize: 20,
      total: 1,
      items: [manualCase],
    } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManualResolutionQueue />);

    expect(await screen.findByRole("heading", { name: "Santos, Ana M." })).toBeVisible();
    expect(screen.getByText("24-0001")).toBeVisible();
    expect(screen.getByText("Generator testing")).toBeVisible();
    expect(screen.getByText(/Laboratory.*2026-08-18.*Awaiting manual reschedule/)).toBeVisible();
    expect(screen.getByText(/Physical Examination.*2026-08-19.*Awaiting manual reschedule/)).toBeVisible();
    expect(screen.getByText(/Opened 2026-07-27/)).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search manual cases"), "24-0001");
    await user.selectOptions(screen.getByLabelText("Service filter"), "LABORATORY");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("search=24-0001"), expect.anything()));
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("service=LABORATORY");
  });

  it("submits a capacity-aware assignment with the optimistic token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 1, items: [manualCase] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "RESOLVED" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 0, items: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManualResolutionQueue />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Santos, Ana M." });

    await user.type(screen.getByLabelText("Laboratory replacement date for 24-0001"), "2026-08-24");
    await user.type(screen.getByLabelText("Physical Examination replacement date for 24-0001"), "2026-08-25");
    await user.type(screen.getByLabelText("Assignment reason for 24-0001"), "Capacity confirmed with both clinics");
    await user.click(screen.getByRole("button", { name: "Assign replacement for 24-0001" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `/api/clinic-unavailable-dates/manual-cases/${manualCase.id}/resolve`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "ASSIGN_REPLACEMENT",
          expectedOptimisticToken: manualCase.optimisticToken,
          laboratoryDate: "2026-08-24",
          physicalExamDate: "2026-08-25",
          reason: "Capacity confirmed with both clinics",
        }),
      }),
    );
  });

  it("requires a reason before keeping the current safe replacement", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {
      page: 1, pageSize: 20, total: 1, items: [manualCase],
    } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManualResolutionQueue />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Santos, Ana M." });

    expect(screen.getByRole("button", { name: "Keep current replacement for 24-0001" })).toBeDisabled();
    await user.type(screen.getByLabelText("Keep-current reason for 24-0001"), "Existing replacement was reviewed and is safe");
    expect(screen.getByRole("button", { name: "Keep current replacement for 24-0001" })).toBeEnabled();
  });
});
