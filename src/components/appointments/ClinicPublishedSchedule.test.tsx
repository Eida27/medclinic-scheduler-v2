import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClinicPublishedSchedule } from "./ClinicPublishedSchedule";

const appointment = {
  id: "appointment-1",
  studentNumber: "2026-0001",
  studentName: "Ana Maria Santos Jr.",
  scheduleType: "LABORATORY",
  appointmentDate: "2026-08-18",
  appointmentTime: "09:30:00",
  status: "PENDING",
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
    expect(screen.queryByRole("combobox", { name: /visibility/i })).not.toBeInTheDocument();

    const row = screen.getByRole("row", { name: /Ana Maria Santos Jr\./ });
    expect(within(row).getByText("2026-0001")).toBeVisible();
    expect(within(row).getByText("2026-08-18")).toBeVisible();
    expect(within(row).getByText("PENDING")).toBeVisible();
    expect(within(row).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/appointments/appointment-1",
    );
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
        }}
        appointments={[{ ...appointment, scheduleType: "PHYSICAL_EXAM" }]}
      />,
    );

    expect(screen.getByText("Page 1 of 2")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/physical-exam?studentNumber=Ana+Santos&appointmentDate=2026-08-18&status=PENDING&page=2",
    );
  });
});
