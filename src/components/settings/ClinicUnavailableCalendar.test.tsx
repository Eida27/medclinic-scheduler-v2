import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import type { ClinicCalendarBatchResult } from "@/types/clinic-calendar";
import { ClinicUnavailableCalendar } from "./ClinicUnavailableCalendar";
import { useUnsavedCalendarNavigation } from "./clinic-calendar/useUnsavedCalendarNavigation";

const clinics = [
  { id: "60000000-0000-4000-8000-000000000001", name: "KABALAKA Clinic" },
  { id: "60000000-0000-4000-8000-000000000002", name: "CPU Clinic" },
];

const unavailableDates: ClinicUnavailableDateRecord[] = [
  {
    id: "unavailable-1",
    clinicId: clinics[0].id,
    clinicCode: "KABALAKA_CLINIC",
    clinicName: clinics[0].name,
    startDate: "2026-07-15",
    endDate: "2026-07-15",
    category: "MAINTENANCE",
    reason: "Generator testing",
    createdByName: "Clinic Admin",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000000Z",
  },
];

function renderCalendar(options?: { withNavigationLink?: boolean }) {
  return render(
    <>
      {options?.withNavigationLink ? <Link href="/appointments">Appointments</Link> : null}
      <ClinicUnavailableCalendar
        clinics={clinics}
        unavailableDates={unavailableDates}
        initialMonth="2026-07"
        today="2026-07-01"
        maxYear={2100}
      />
    </>,
  );
}

async function configureBlock(
  category: "HOLIDAY" | "CLOSURE" | "MAINTENANCE" | "STAFF_UNAVAILABILITY" = "MAINTENANCE",
  reason = "Equipment maintenance",
) {
  await userEvent.selectOptions(screen.getByLabelText("Category"), category);
  await userEvent.clear(screen.getByLabelText("Reason"));
  await userEvent.type(screen.getByLabelText("Reason"), reason);
}

function batchResult(overrides: Partial<ClinicCalendarBatchResult> = {}): ClinicCalendarBatchResult {
  return {
    batchId: "batch-1",
    activeUnavailableDates: unavailableDates,
    blockedDateCount: 1,
    unblockedDateCount: 1,
    movedStudentCount: 2,
    movedAppointmentCount: 3,
    restoredStudentCount: 1,
    restoredAppointmentCount: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function UnsavedNavigationHarness({ navigate }: { navigate(href: string): void }) {
  const navigation = useUnsavedCalendarNavigation(true, navigate);
  return (
    <>
      <Link href="/appointments">Harness appointments</Link>
      {navigation.pendingHref ? (
        <button type="button" onClick={navigation.discardAndLeave}>Harness discard and leave</button>
      ) : null}
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ClinicUnavailableCalendar draft sessions", () => {
  it("stages and cancels a block without making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderCalendar();
    await configureBlock();

    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "July 14, 2026 — will be blocked: Maintenance" })).toBeEnabled();
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "July 14, 2026 — will be blocked: Maintenance" }));

    expect(screen.getByRole("button", { name: "July 14, 2026 — available" })).toBeEnabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stages and cancels reopening a saved blocked weekday", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderCalendar();

    await user.click(screen.getByRole("button", {
      name: "July 15, 2026 — blocked: Maintenance, Generator testing",
    }));

    expect(screen.getByRole("button", { name: "July 15, 2026 — will be reopened" })).toBeEnabled();
    expect(screen.getByText("Reopen 1 date")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "July 15, 2026 — will be reopened" }));

    expect(screen.getByRole("button", {
      name: "July 15, 2026 — blocked: Maintenance, Generator testing",
    })).toBeEnabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
  });

  it("retains all drafts across clinic, month, and year controls", async () => {
    const user = userEvent.setup();
    renderCalendar();
    await configureBlock();
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));

    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[1].id);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(screen.getByRole("button", { name: "August 18, 2026 — available" }));

    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "August 18, 2026 — will be blocked: Maintenance" })).toBeEnabled();
    expect(screen.getByText("2 unsaved changes")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Unsaved calendar changes" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[0].id);
    await user.selectOptions(screen.getByLabelText("Month"), "7");

    expect(screen.getByRole("heading", { name: "July 2026" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "July 14, 2026 — will be blocked: Maintenance" })).toBeEnabled();
    expect(screen.getByText("2 unsaved changes")).toBeInTheDocument();
  });

  it("copies category and reason when each block is staged and sorts the one batch by date then clinic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: batchResult() }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderCalendar();
    await configureBlock("MAINTENANCE", "Generator overhaul");
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));

    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[1].id);
    await configureBlock("HOLIDAY", "Foundation day");
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(screen.getByRole("button", { name: "August 18, 2026 — available" }));

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await user.click(saveButton);
    expect(screen.getAllByRole("dialog", { name: "Save clinic calendar changes" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Confirm and save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/clinic-unavailable-dates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: [
          {
            action: "BLOCK",
            clinicId: clinics[0].id,
            date: "2026-07-14",
            category: "MAINTENANCE",
            reason: "Generator overhaul",
          },
          {
            action: "BLOCK",
            clinicId: clinics[1].id,
            date: "2026-07-14",
            category: "HOLIDAY",
            reason: "Foundation day",
          },
          {
            action: "BLOCK",
            clinicId: clinics[1].id,
            date: "2026-08-18",
            category: "HOLIDAY",
            reason: "Foundation day",
          },
        ],
      }),
    });
  });

  it("discards drafts across all clinics and months", async () => {
    const user = userEvent.setup();
    renderCalendar();
    await configureBlock();
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));
    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[1].id);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(screen.getByRole("button", { name: "August 18, 2026 — available" }));

    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "August 18, 2026 — available" })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[0].id);
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("button", { name: "July 14, 2026 — available" })).toBeEnabled();
  });

  it("uses one confirmation and returns focus to the real Save button when canceling", async () => {
    const user = userEvent.setup();
    renderCalendar();
    await configureBlock();
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));
    const saveButton = screen.getByRole("button", { name: "Save changes" });

    await user.click(saveButton);

    const dialog = screen.getByRole("dialog", { name: "Save clinic calendar changes" });
    expect(within(dialog).getByText("KABALAKA Clinic")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Save clinic calendar changes" })).not.toBeInTheDocument();
    expect(saveButton).toHaveFocus();
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("guards duplicate confirmation while pending and refreshes records without resetting the view", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderCalendar();
    await configureBlock();
    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[1].id);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(screen.getByRole("button", { name: "August 18, 2026 — available" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm and save" });
    await user.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(confirmButton).toBeDisabled();
    expect(screen.getByLabelText("Clinic")).toBeDisabled();

    const savedCpuRecord: ClinicUnavailableDateRecord = {
      id: "unavailable-cpu",
      clinicId: clinics[1].id,
      clinicCode: "CPU_CLINIC",
      clinicName: clinics[1].name,
      startDate: "2026-08-18",
      endDate: "2026-08-18",
      category: "MAINTENANCE",
      reason: "Equipment maintenance",
      createdByName: "Clinic Admin",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.123456Z",
    };
    response.resolve(jsonResponse({
      data: batchResult({ activeUnavailableDates: [...unavailableDates, savedCpuRecord] }),
    }));

    const success = await screen.findByRole("alert");
    expect(success).toHaveTextContent("1 date blocked");
    expect(success).toHaveTextContent("1 date reopened");
    expect(success).toHaveTextContent("2 students");
    expect(success).toHaveTextContent("3 appointments moved");
    expect(success).toHaveTextContent("1 student");
    expect(success).toHaveTextContent("2 appointments restored");
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    expect(screen.getByLabelText("Clinic")).toHaveValue(clinics[1].id);
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();
    const refreshedDate = screen.getByRole("button", {
      name: "August 18, 2026 — blocked: Maintenance, Equipment maintenance",
    });
    expect(refreshedDate).toBeEnabled();
    expect(refreshedDate).toHaveAttribute("data-highlighted", "true");
  });

  it("preserves the complete draft and highlights date-specific issues after rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "CLINIC_CALENDAR_BATCH_REJECTED",
        message: "The clinic calendar changes could not be saved.",
        details: {
          issues: [{
            action: "BLOCK",
            clinicId: clinics[1].id,
            date: "2026-08-18",
            code: "CAPACITY_CONFLICT",
            message: "No safe replacement date has capacity.",
          }],
        },
      },
    }, 409));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderCalendar();
    await configureBlock();
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));
    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[1].id);
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(screen.getByRole("button", { name: "August 18, 2026 — available" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(screen.getByRole("button", { name: "Confirm and save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The clinic calendar changes could not be saved.");
    expect(screen.queryByRole("dialog", { name: "Save clinic calendar changes" })).not.toBeInTheDocument();
    expect(screen.getByText("2 unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "August 18, 2026 — conflict: No safe replacement date has capacity.",
    })).toBeEnabled();
    expect(screen.getByLabelText("Clinic")).toHaveValue(clinics[1].id);
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Clinic"), clinics[0].id);
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("button", { name: "July 14, 2026 — will be blocked: Maintenance" })).toBeEnabled();
  });
});

describe("ClinicUnavailableCalendar unsaved navigation", () => {
  it("prevents beforeunload only while drafts exist", async () => {
    const user = userEvent.setup();
    renderCalendar();

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await configureBlock();
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });

  it("keeps same-origin navigation pending on Stay and restores focus to the intercepted link", async () => {
    const user = userEvent.setup();
    renderCalendar({ withNavigationLink: true });
    await configureBlock();
    await user.click(screen.getByRole("button", { name: "July 14, 2026 — available" }));
    const link = screen.getByRole("link", { name: "Appointments" });

    await user.click(link);

    const dialog = screen.getByRole("dialog", { name: "Unsaved calendar changes" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Continue editing" }));

    expect(screen.queryByRole("dialog", { name: "Unsaved calendar changes" })).not.toBeInTheDocument();
    expect(link).toHaveFocus();
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("discards drafts and performs the one pending same-origin navigation", async () => {
    const assign = vi.fn();
    const user = userEvent.setup();
    render(<UnsavedNavigationHarness navigate={assign} />);
    await user.click(screen.getByRole("link", { name: "Harness appointments" }));

    await user.click(screen.getByRole("button", { name: "Harness discard and leave" }));

    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith("http://localhost:3000/appointments");
  });
});
