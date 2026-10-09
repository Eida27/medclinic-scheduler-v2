import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { ClinicPublishedSchedule } from "./ClinicPublishedSchedule";

const appointment = {
  id: "appointment-1",
  studentNumber: "2026-0001",
  studentName: "Ana Maria Santos Jr.",
  scheduleType: "LABORATORY",
  appointmentDate: "2026-08-18",
  status: "PENDING",
  completedFromStatus: null,
  isManuallyLocked: true,
};

describe("ClinicPublishedSchedule", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { mode: "FOURTH_YEAR_OJT", verified: 3, required: 4, ready: true, missing: [] },
    { mode: "FIRST_YEAR_EXTERNAL", verified: 0, required: 4, ready: true, missing: [] },
    { mode: "FOURTH_YEAR_OJT", verified: 2, required: 4, ready: false, missing: ["STOOL"] },
    { mode: "STANDARD", verified: 0, required: 3, ready: false, missing: ["CBC", "URINE", "STOOL"] },
  ])("opens authoritative completion context for pending $mode ($verified/$required)", async ({ mode, verified, required, ready, missing }) => {
    const blockers = ready ? [] : ["Verify Laboratory tests before Physical Examination: " + missing.join(", ") + "."];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {
      appointmentId: appointment.id, studentName: appointment.studentName, studentNumber: appointment.studentNumber,
      appointmentDate: appointment.appointmentDate, scheduleCycleStart: 2026, dateOfBirth: "2005-01-01",
      studentAcademicSnapshot: { studentName: appointment.studentName, collegeName: "College", programName: "Program", yearLevel: mode === "FIRST_YEAR_EXTERNAL" ? 1 : 4 },
      physicians: [{ id: "physician-1", version: 1, displayName: "Synthetic Physician", licenseNumber: "TEST", specialty: null }], blockers,
      laboratoryCompletion: { laboratoryAppointmentId: "lab-1", laboratoryCompleted: false,
        readyForPe: ready, missingManualTestCodes: missing,
        completionPolicy: { mode, manualTestCodes: mode === "FIRST_YEAR_EXTERNAL" ? [] : ["CBC", "URINE", "STOOL"],
          peConfirmedTestCodes: mode === "FIRST_YEAR_EXTERNAL" ? ["CBC", "URINE", "STOOL", "XRAY"] : mode === "FOURTH_YEAR_OJT" ? ["XRAY"] : [],
          externalProvider: mode === "STANDARD" ? null : "Iloilo Mission Hospital" } },
    } }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ClinicPublishedSchedule basePath="/physical-exam" title="Physical Examination"
      description="Current appointments" emptyMessage="No appointments" page={1} total={1}
      filters={{}} showLaboratoryStatus canCompletePhysicalExam appointments={[{ ...appointment,
        scheduleType: "PHYSICAL_EXAM", laboratoryStatus: "PENDING", laboratoryVerifiedTests: verified,
        laboratoryRequiredTests: required, isOvpsaFirstYear: mode === "FIRST_YEAR_EXTERNAL" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Complete Physical Examination" }));
    const submit = await screen.findByRole("button", { name: "Submit" });
    if (ready) expect(submit).toBeEnabled();
    else {
      expect(submit).toBeDisabled();
      expect(screen.getByText(blockers[0])).toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/appointments/${appointment.id}/physical-exam-completion-context`);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("method");
  });

  it("renders published schedule filters and appointments without draft or visibility controls", () => {
    render(
      <ClinicPublishedSchedule
        basePath="/laboratory"
        title="Published laboratory schedule"
        description="1 published KABALAKA Clinic laboratory appointment matches the current filters."
        emptyMessage="No published laboratory appointments match these filters."
        page={1}
        total={1}
        filters={{
          studentNumber: "Ana Santos",
          appointmentDate: "2026-08-18",
          status: "PENDING",
          sort: "surname_desc",
        }}
        appointments={[appointment]}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Published laboratory schedule" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Student name or number" })).toHaveValue("Ana Santos");
    expect(screen.getByLabelText("Appointment date")).toHaveValue("2026-08-18");

    const status = screen.getByRole("combobox", { name: "Status" });
    expect(status).toHaveValue("PENDING");
    expect(within(status).queryByRole("option", { name: "DRAFT" })).not.toBeInTheDocument();
    expect(within(status).getByRole("option", { name: "No-show" })).toHaveValue("NO_SHOW");
    expect(within(status).queryByRole("option", { name: "Rescheduled" })).not.toBeInTheDocument();
    expect(within(status).queryByRole("option", { name: "Cancelled" })).not.toBeInTheDocument();
    expect(within(status).queryByRole("option", { name: "Awaiting manual reschedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /visibility/i })).not.toBeInTheDocument();

    const sort = screen.getByRole("combobox", { name: "Sort" });
    expect(sort).toHaveValue("surname_desc");
    expect(within(sort).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Surname A-Z",
      "Surname Z-A",
      "Soonest",
      "Latest",
    ]);

    const row = screen.getByRole("row", { name: /Ana Maria Santos Jr\./ });
    expect(within(row).getByRole("link", { name: "Ana Maria Santos Jr." })).toHaveAttribute(
      "href",
      "/laboratory/appointment-1",
    );
    expect(within(row).getByRole("link", { name: "2026-0001" })).toHaveAttribute(
      "href",
      "/laboratory/appointment-1",
    );
    expect(within(row).getByText("2026-08-18")).toBeVisible();
    expect(within(row).getByText("Loading Laboratory checklist…")).toBeVisible();
    expect(within(row).queryByRole("button", { name: /mark completed/i })).not.toBeInTheDocument();
    expect(within(row).getByText("Protected")).toHaveAttribute("aria-label", "Appointment manually locked");
    expect(within(row).queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(screen.getByText("Page 1 of 1")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Next page" })).not.toBeInTheDocument();
  });

  it.each([
    "No published laboratory appointments match these filters.",
    "No published physical examination appointments match these filters.",
  ])("renders the configured exact empty state: %s", (emptyMessage) => {
    render(
      <ClinicPublishedSchedule
        basePath="/laboratory"
        title="Published schedule"
        description="No published appointments match the current filters."
        emptyMessage={emptyMessage}
        page={1}
        total={0}
        filters={{}}
        appointments={[]}
      />,
    );

    expect(screen.getByText(emptyMessage)).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Appointment pagination" })).not.toBeInTheDocument();
  });

  it.each([
    ["PENDING", "Pending", "bg-slate-100", "text-slate-800"],
    ["COMPLETED", "Completed", "bg-emerald-100", "text-emerald-800"],
    ["NO_SHOW", "No-show", "bg-red-100", "text-red-800"],
    [null, "Not available", "bg-slate-100", "text-muted"],
  ] as const)("renders the physical examination laboratory status %s as a read-only badge", (laboratoryStatus, label, backgroundClass, textClass) => {
    render(
      <ClinicPublishedSchedule
        basePath="/physical-exam"
        title="Published physical examination schedule"
        description="1 published physical examination appointment matches the current filters."
        emptyMessage="No published physical examination appointments match these filters."
        page={1}
        total={1}
        filters={{}}
        showLaboratoryStatus
        appointments={[{ ...appointment, scheduleType: "PHYSICAL_EXAM", laboratoryStatus }]}
      />,
    );

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Student",
      "Service",
      "Date",
      "Laboratory Status",
      "Physical Exam Status",
    ]);
    const row = screen.getByRole("row", { name: new RegExp(label) });
    const laboratoryCell = within(row).getAllByRole("cell")[3];
    const laboratoryBadge = within(laboratoryCell).getByText(label);
    expect(laboratoryBadge.tagName).toBe("SPAN");
    expect(laboratoryBadge).toHaveClass(backgroundClass, textClass);
    expect(within(laboratoryCell).queryByRole("button", { name: label })).not.toBeInTheDocument();
    expect(within(laboratoryCell).queryByRole("link", { name: label })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Complete Physical Examination" })).not.toBeInTheDocument();
    expect(within(row).queryByText(/Laboratory must be completed/)).not.toBeInTheDocument();
  });

  it("shows an authorized completion button without navigating and opens the dialog", () => {
    render(<ClinicPublishedSchedule basePath="/physical-exam" title="Physical Examination"
      description="Current appointments" emptyMessage="No appointments" page={1} total={1}
      filters={{}} showLaboratoryStatus canCompletePhysicalExam appointments={[{ ...appointment,
        scheduleType: "PHYSICAL_EXAM", laboratoryStatus: "COMPLETED", isManuallyLocked: false }]} />);
    expect(screen.getByRole("link", { name: "Ana Maria Santos Jr." })).toHaveAttribute("href", "/physical-exam/appointment-1");
    fireEvent.click(screen.getByRole("button", { name: "Complete Physical Examination" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(window.location.pathname).not.toContain("appointment-1");
  });

  it("shows read-only Laboratory test progress on a Physical Examination row", () => {
    render(<ClinicPublishedSchedule basePath="/physical-exam" title="Physical Examination"
      description="Current appointments" emptyMessage="No appointments" page={1} total={1}
      filters={{}} showLaboratoryStatus appointments={[{ ...appointment,
        scheduleType: "PHYSICAL_EXAM", laboratoryStatus: "PENDING",
        laboratoryVerifiedTests: 2, laboratoryRequiredTests: 3 }]} />);

    const row = screen.getByRole("row", { name: /Ana Maria Santos Jr\./ });
    expect(within(row).getByText("2/3 verified")).toBeVisible();
    expect(within(row).queryByRole("checkbox", { name: /CBC|Urine|Stool|X-ray/ })).not.toBeInTheDocument();
  });

  it("keeps completed Physical Examination status read only in the schedule", () => {
    render(
      <ClinicPublishedSchedule
        basePath="/physical-exam"
        title="Published physical examination schedule"
        description="1 appointment"
        emptyMessage="No appointments"
        page={1}
        total={1}
        filters={{}}
        showLaboratoryStatus
        appointments={[{
          ...appointment,
          scheduleType: "PHYSICAL_EXAM",
          status: "COMPLETED",
          completedFromStatus: "PENDING",
          laboratoryStatus: "PENDING",
        }]}
      />,
    );

    expect(screen.getAllByText("Completed")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /restore pending/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Laboratory must be completed/)).not.toBeInTheDocument();
  });

  it("keeps the laboratory table at four columns without the cross-clinic status", () => {
    render(
      <ClinicPublishedSchedule
        basePath="/laboratory"
        title="Published laboratory schedule"
        description="1 published laboratory appointment matches the current filters."
        emptyMessage="No published laboratory appointments match these filters."
        page={1}
        total={1}
        filters={{}}
        appointments={[appointment]}
      />,
    );

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Student",
      "Service",
      "Date",
      "Status",
    ]);
    expect(screen.queryByRole("columnheader", { name: "Laboratory Status" })).not.toBeInTheDocument();
  });

  it("renders clinic pagination and preserves clinic filters", () => {
    render(
      <ClinicPublishedSchedule
        basePath="/physical-exam"
        title="Published physical examination schedule"
        description="280 published appointments match the current filters."
        emptyMessage="No published physical examination appointments match these filters."
        page={1}
        total={280}
        filters={{
          studentNumber: "Ana Santos",
          appointmentDate: "2026-08-18",
          status: "PENDING",
          sort: "latest",
        }}
        appointments={[{ ...appointment, scheduleType: "PHYSICAL_EXAM" }]}
      />,
    );

    expect(screen.getByText("Page 1 of 2")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/physical-exam?studentNumber=Ana+Santos&sort=latest&appointmentDate=2026-08-18&status=PENDING&page=2",
    );
    expect(screen.getByRole("link", { name: "Ana Maria Santos Jr." })).toHaveAttribute(
      "href",
      "/physical-exam/appointment-1",
    );
  });

  it("clears bulk selection when the student filter changes, including when returning", async () => {
    sessionStorage.clear();
    const props = {
      basePath: "/laboratory", title: "Laboratory", description: "Appointments",
      emptyMessage: "No appointments", page: 1, total: 1, canBulkReplace: true,
      appointments: [{ ...appointment, isManuallyLocked: false,
        updatedAt: "2026-09-23T00:00:00.000Z" }],
    };
    const view = render(<ClinicPublishedSchedule {...props} filters={{ studentNumber: "Ana" }} />);
    const selectedCount = (count: number) => screen.getByText(`${count} selected (maximum 100)`);
    const settleSelection = async () => act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await settleSelection();
    fireEvent.click(screen.getByRole("checkbox", { name: /Select Ana Maria Santos Jr. for replacement/ }));
    selectedCount(1);
    view.rerender(<ClinicPublishedSchedule {...props} page={2}
      filters={{ studentNumber: "Ana", sort: "latest" }} />);
    await settleSelection();
    selectedCount(1);
    view.rerender(<ClinicPublishedSchedule {...props} filters={{ studentNumber: "Ben" }} />);
    await settleSelection();
    selectedCount(0);
    view.rerender(<ClinicPublishedSchedule {...props} filters={{ studentNumber: "Ana" }} />);
    await settleSelection();
    selectedCount(0);
  });
});
