import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import { ClinicUnavailableCalendar } from "./ClinicUnavailableCalendar";

const unavailableDates: ClinicUnavailableDateRecord[] = [{
  id: "70000000-0000-4000-8000-000000000001",
  closureGroupId: "71000000-0000-4000-8000-000000000001",
  blockedDate: "2026-08-19",
  groupStartDate: "2026-08-19",
  groupEndDate: "2026-08-19",
  category: "MAINTENANCE",
  reason: "Generator testing",
  createdByName: "Clinic Admin",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000000Z",
}];

const preview = {
  requestId: "72000000-0000-4000-8000-000000000001",
  closureGroups: [],
  datesBeingReopened: [],
  affectedStudentCount: 2,
  automaticRecoveryEligibleCount: 2,
  manualResolutionRequiredCount: 0,
  completePairMoveEstimate: 1,
  laboratoryOnlyMoveEstimate: 0,
  physicalOnlyMoveEstimate: 1,
  preservedAppointmentCount: 0,
  expectedCapacityFallbackCount: 0,
  manualReasonGroups: [],
};

const operationResult = {
  requestId: preview.requestId,
  batchId: "73000000-0000-4000-8000-000000000001",
  activeUnavailableDates: unavailableDates,
  blockedDateCount: 1,
  reopenedDateCount: 0,
  autoRecoveredStudentCount: 2,
  movedStudentCount: 2,
  movedAppointmentCount: 3,
  preservedAppointmentCount: 0,
  manualCaseCount: 0,
  capacityFallbackCount: 0,
  manualReasonGroups: [],
  notificationWarningCount: 0,
};

function renderCalendar(props: Partial<React.ComponentProps<typeof ClinicUnavailableCalendar>> = {}) {
  return render(
    <ClinicUnavailableCalendar
      unavailableDates={unavailableDates}
      initialYear={2026}
      today="2026-07-27"
      maxYear={2100}
      openManualCaseCount={2}
      {...props}
    />,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const emptyOccupancy = { year: 2026, capacities: { LABORATORY: 10, PHYSICAL_EXAM: 10 }, dates: [] };
function calendarFetch(...responses: Response[]) {
  let index = 0;
  return vi.fn((url: string, init?: RequestInit) => {
    void init;
    return Promise.resolve(url.startsWith("/api/clinic-calendar/occupancy")
      ? jsonResponse({ data: emptyOccupancy })
      : responses[Math.min(index++, responses.length - 1)]);
  });
}

function stageAugust18() {
  renderCalendar();
  fireEvent.change(screen.getByLabelText("Closure reason"), {
    target: { value: "Campus-wide maintenance" },
  });
  fireEvent.click(screen.getByRole("button", { name: /August 18, 2026:/ }));
}

describe("ClinicUnavailableCalendar", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => preview.requestId });
    vi.stubGlobal("fetch", calendarFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders all twelve true-date month grids without adjacent-month dates", () => {
    renderCalendar();

    for (const month of [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ]) {
      expect(screen.getByRole("heading", { name: month })).toBeVisible();
    }
    const august = screen.getByRole("heading", { name: "August" }).closest("section");
    expect(august).not.toBeNull();
    expect(within(august!).getByRole("button", { name: /August 1, 2026/ })).toBeVisible();
    expect(within(august!).queryByRole("button", { name: /July 31|September 1/ })).not.toBeInTheDocument();
    expect(screen.getByText("2 open manual cases")).toBeVisible();
  });

  it("keeps date-only drafts while navigating between years", async () => {
    stageAugust18();
    expect(screen.getByRole("button", { name: /August 18, 2026: Selected to block/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByLabelText("Calendar year"), { target: { value: "2027" } });
    expect(screen.getByRole("heading", { name: "January" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Calendar year"), { target: { value: "2026" } });

    expect(screen.getByRole("button", { name: /August 18, 2026: Selected to block/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 unsaved change")).toBeVisible();
  }, 30000);

  it("keeps an unsaved draft when server calendar props refresh", async () => {
    const view = renderCalendar();
    fireEvent.change(screen.getByLabelText("Closure reason"), { target: { value: "Campus-wide maintenance" } });
    fireEvent.click(screen.getByRole("button", { name: /August 18, 2026:/ }));
    const refreshedDates = [...unavailableDates, {
      ...unavailableDates[0],
      id: "70000000-0000-4000-8000-000000000002",
      blockedDate: "2026-08-20",
      groupStartDate: "2026-08-20",
      groupEndDate: "2026-08-20",
    }];
    view.rerender(<ClinicUnavailableCalendar unavailableDates={refreshedDates}
      initialYear={2026} today="2026-07-28" maxYear={2100} openManualCaseCount={2} />);
    expect(screen.getByRole("button", { name: /August 18, 2026: Selected to block/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /August 20, 2026: MAINTENANCE/ })).toBeVisible();
    expect(screen.getByText("1 unsaved change")).toBeVisible();
  }, 60000);

  it("previews before saving and sends the exact public request payload", async () => {
    const fetchMock = calendarFetch(jsonResponse({ data: preview }), jsonResponse({ data: operationResult }));
    vi.stubGlobal("fetch", fetchMock);
    stageAugust18();

    fireEvent.click(screen.getByRole("button", { name: "Review impact" }));
    expect(await screen.findByRole("dialog", { name: "Confirm clinic calendar impact" })).toBeVisible();
    expect(screen.getByText("Automatic eligible").nextSibling).toHaveTextContent("2");
    expect(screen.getByRole("radio", { name: /Automatically reschedule eligible appointments/ })).toBeChecked();
    expect(fetchMock).toHaveBeenCalledWith("/api/clinic-unavailable-dates/preview", expect.objectContaining({
      method: "POST",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => !String(url).startsWith("/api/clinic-calendar/occupancy"))).toHaveLength(2));
    const mutationCalls = fetchMock.mock.calls.filter(([url]) => !String(url).startsWith("/api/clinic-calendar/occupancy"));
    const previewPayload = JSON.parse(String(mutationCalls[0][1]?.body));
    const savePayload = JSON.parse(String(mutationCalls[1][1]?.body));
    const expectedChange = {
      action: "BLOCK",
      date: "2026-08-18",
      category: "CLOSURE",
      reason: "Campus-wide maintenance",
    };
    expect(previewPayload).toEqual({
      requestId: preview.requestId,
      changes: [expectedChange],
      emergencyAcknowledged: false,
    });
    expect(savePayload).toEqual({
      ...previewPayload,
      recoveryMode: "AUTO_ELIGIBLE",
    });
    expect(await screen.findByText(/Saved 1 blocked and 0 reopened dates/)).toBeVisible();
  });

  it("permits today only for an acknowledged emergency closure", async () => {
    const fetchMock = calendarFetch(jsonResponse({ data: {
      ...preview,
      automaticRecoveryEligibleCount: 0,
      manualResolutionRequiredCount: 2,
      manualReasonGroups: [{ reasonCode: "EMERGENCY_CLOSURE", count: 2 }],
    } }));
    vi.stubGlobal("fetch", fetchMock);
    renderCalendar();
    const todayButton = screen.getByRole("button", { name: /July 27, 2026:/ });

    expect(todayButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Closure category"), { target: { value: "EMERGENCY_CLOSURE" } });
    fireEvent.change(screen.getByLabelText("Closure reason"), { target: { value: "Emergency water outage" } });
    expect(todayButton).toBeEnabled();
    fireEvent.click(todayButton);
    fireEvent.click(screen.getByRole("button", { name: "Review impact" }));

    const confirm = await screen.findByRole("button", { name: "Confirm and save" });
    expect(screen.getByRole("radio", { name: /Automatically reschedule eligible appointments/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Send eligible appointments to Manual Resolution/ })).toBeChecked();
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /acknowledge this same-day emergency closure/i }));
    expect(confirm).toBeEnabled();
  });

  it("invalidates an impact preview whenever the draft configuration changes", async () => {
    vi.stubGlobal("fetch", calendarFetch(jsonResponse({ data: preview })));
    stageAugust18();
    fireEvent.click(screen.getByRole("button", { name: "Review impact" }));
    expect(await screen.findByRole("dialog", { name: "Confirm clinic calendar impact" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Closure reason"), { target: { value: "Updated maintenance reason" } });

    expect(screen.queryByRole("dialog", { name: "Confirm clinic calendar impact" })).not.toBeInTheDocument();
  });

  it("shows clinic staff the same annual calendar without editing controls", () => {
    renderCalendar({ readOnly: true });

    expect(screen.getByText("This calendar is read-only for clinic staff.")).toBeVisible();
    expect(screen.queryByLabelText("Closure category")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Closure reason")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review impact" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Manual Resolution/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /August 19, 2026: MAINTENANCE/ })).toBeDisabled();
  });

  it("keeps day details open when the info button receives focus and is clicked", async () => {
    renderCalendar();
    const info = screen.getByRole("button", { name: "View day details for 2026-08-18" });

    fireEvent.focus(info);
    fireEvent.click(info);

    expect(screen.getByRole("dialog", { name: "Calendar details for 2026-08-18" })).toBeVisible();
  });

  it("distinguishes unconfigured capacity from an available date", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: {
      year: 2026,
      capacities: { LABORATORY: null, PHYSICAL_EXAM: 10 },
      dates: [],
    } })));
    renderCalendar();

    const day = await screen.findByRole("button", { name: /August 18, 2026: Capacity not configured/ });
    expect(day).toHaveClass("bg-slate-100");
    fireEvent.click(screen.getByRole("button", { name: "View day details for 2026-08-18" }));
    expect(screen.getByRole("dialog", { name: "Calendar details for 2026-08-18" }))
      .toHaveTextContent("Capacity not configured");
  });
});
