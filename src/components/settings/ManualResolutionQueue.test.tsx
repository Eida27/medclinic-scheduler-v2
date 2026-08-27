import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualResolutionQueue } from "./ManualResolutionQueue";

const manualCase = {
  id: "80000000-0000-4000-8000-000000000001",
  studentNumber: "24-0001",
  studentName: "Santos, Ana M.",
  caseSource: "CLINIC_CLOSURE",
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
  laboratory: { id: "lab-1", date: "2026-08-18", status: "AWAITING_RESCHEDULE", affected: true },
  physicalExam: { id: "pe-1", date: "2026-08-19", status: "AWAITING_RESCHEDULE", affected: true },
  ovpsaBatchId: null,
  ovpsaBatchOptimisticToken: null,
  currentAssignmentBlock: null,
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
    expect(screen.getByText("Closure:").parentElement).toHaveTextContent("Closure: 2026-08-18 to 2026-08-19");
    expect(screen.getByText("Category:").parentElement).toHaveTextContent("Category: Maintenance");
    expect(screen.getByText("Reason:").parentElement).toHaveTextContent("Reason: Generator testing");
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

  it("renders and resolves an automatic-displacement case without closure context", async () => {
    const automaticCase = {
      ...manualCase,
      id: "80000000-0000-4000-8000-000000000099",
      studentNumber: "24-0099",
      studentName: "Automatic, Aria",
      caseSource: "AUTOMATIC_DISPLACEMENT",
      closureGroupId: null,
      groupStartDate: null,
      groupEndDate: null,
      category: null,
      closureReason: null,
      reasonCode: "NO_VALID_REPLACEMENT_WITHIN_CYCLE",
      reasonMessage: "No valid automatic replacement remained inside the cycle.",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 1, items: [automaticCase] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "RESOLVED" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 0, items: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManualResolutionQueue />);
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Automatic, Aria" })).toBeVisible();
    expect(screen.getByText("Automatic priority displacement")).toBeVisible();
    expect(screen.getByText("No clinic closure is associated with this case.")).toBeVisible();
    expect(screen.queryByText(/^Closure:/)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "No valid replacement within cycle" })).toHaveValue(
      "NO_VALID_REPLACEMENT_WITHIN_CYCLE",
    );

    await user.type(screen.getByLabelText("Laboratory replacement date for 24-0099"), "2026-08-24");
    await user.type(screen.getByLabelText("Physical Examination replacement date for 24-0099"), "2026-08-25");
    await user.type(screen.getByLabelText("Assignment reason for 24-0099"), "Same-cycle capacity confirmed");
    await user.click(screen.getByRole("button", { name: "Assign replacement for 24-0099" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `/api/clinic-unavailable-dates/manual-cases/${automaticCase.id}/resolve`,
      expect.objectContaining({ method: "POST" }),
    );
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

  it("requires an explicit preservation decision for a related unaffected appointment", async () => {
    const relatedCase = {
      ...manualCase,
      laboratory: { ...manualCase.laboratory!, affected: true },
      physicalExam: { ...manualCase.physicalExam!, status: "PENDING", affected: false },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 1, items: [relatedCase] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "RESOLVED" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 0, items: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManualResolutionQueue />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Santos, Ana M." });

    expect(screen.getByText("Affected", { selector: "span" })).toBeVisible();
    expect(screen.getByText("Related / currently unaffected", { selector: "span" })).toBeVisible();
    expect(screen.queryByLabelText("Physical Examination replacement date for 24-0001")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Laboratory replacement date for 24-0001"), "2026-08-24");
    await user.click(screen.getByRole("radio", { name: "Preserve current Physical Examination" }));
    await user.type(screen.getByLabelText("Assignment reason for 24-0001"), "The related examination remains safely later");
    await user.click(screen.getByRole("button", { name: "Assign replacement for 24-0001" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      laboratoryDate: "2026-08-24",
      preservePhysicalExam: true,
    });
  });

  it("groups OVPSA Laboratory cases into one coordinated preview and confirmation", async () => {
    const ovpsaCases = ["24-0001", "24-0002"].map((studentNumber, index) => ({
      ...manualCase,
      id: `80000000-0000-4000-8000-00000000000${index + 1}`,
      studentNumber,
      studentName: `OVPSA Student ${index + 1}`,
      optimisticToken: `82000000-0000-4000-8000-00000000000${index + 1}`,
      reasonCode: "OVPSA_LABORATORY_PROTECTED",
      ovpsaBatchId: "83000000-0000-4000-8000-000000000001",
      ovpsaBatchOptimisticToken: "84000000-0000-4000-8000-000000000001",
      laboratory: { ...manualCase.laboratory!, affected: true },
      physicalExam: { ...manualCase.physicalExam!, status: "PENDING", affected: false },
    }));
    const batchPreview = {
      batchId: ovpsaCases[0].ovpsaBatchId,
      optimisticToken: ovpsaCases[0].ovpsaBatchOptimisticToken,
      replacementLaboratoryDate: "2026-09-01",
      linkedCaseCount: 2,
      preservedPhysicalExamCount: 1,
      movedPhysicalExamCount: 1,
      allocations: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 2, items: ovpsaCases } }))
      .mockResolvedValueOnce(jsonResponse({ data: batchPreview }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...batchPreview, revisionId: "revision-2", revisionNumber: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { page: 1, pageSize: 20, total: 0, items: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManualResolutionQueue />);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Coordinated OVPSA batch recovery" })).toBeVisible();
    await user.type(screen.getByLabelText("Replacement Mission Hospital Laboratory date"), "2026-09-01");
    await user.click(screen.getByRole("button", { name: "Preview OVPSA batch recovery" }));
    expect(await screen.findByText("1 Physical Examination preserved; 1 moved.")).toBeVisible();
    await user.type(screen.getByLabelText("OVPSA batch recovery reason"), "Mission Hospital date approved");
    await user.click(screen.getByRole("button", { name: "Confirm OVPSA batch recovery" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      caseTokens: ovpsaCases.map((item) => ({
        caseId: item.id,
        expectedOptimisticToken: item.optimisticToken,
      })),
    });
  });

  it("explains live draft protection, links to result review, and disables resolution controls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: {
      page: 1,
      pageSize: 20,
      total: 1,
      items: [{
        ...manualCase,
        reasonCode: "DRAFT_RESULT_FILES_EXIST",
        currentAssignmentBlock: {
          code: "DRAFT_RESULT_FILES_EXIST",
          message: "Draft result files exist. Remove them before assigning a replacement.",
        },
      }],
    } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManualResolutionQueue />);

    expect(await screen.findByRole("link", { name: "Review student results" })).toHaveAttribute(
      "href",
      "/settings/student-result-submissions/students/24-0001",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Draft result files exist/);
    expect(screen.getByLabelText("Laboratory replacement date for 24-0001")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Assign replacement for 24-0001" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep current replacement for 24-0001" })).toBeDisabled();
  });
});
