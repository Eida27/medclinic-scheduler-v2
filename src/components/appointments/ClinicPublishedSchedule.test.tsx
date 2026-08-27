import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
    expect(within(row).getByRole("button", { name: "Pending — click to mark completed" })).toBeVisible();
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
    const quickStatus = within(row).getByRole("button", { name: "Pending — click to mark completed" });
    if (laboratoryStatus === "COMPLETED") {
      expect(quickStatus).toBeEnabled();
      expect(within(row).queryByText(/Laboratory must be completed/)).not.toBeInTheDocument();
    } else {
      const explanation = within(row).getByText(
        "Laboratory must be completed before Physical Examination can be marked completed.",
      );
      expect(quickStatus).toBeDisabled();
      expect(quickStatus).toHaveAttribute("aria-describedby", explanation.id);
    }
  });

  it("keeps a completed Physical Examination revert available when Laboratory is incomplete", () => {
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

    expect(screen.getByRole("button", { name: "Completed — click to restore pending" })).toBeEnabled();
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
});
