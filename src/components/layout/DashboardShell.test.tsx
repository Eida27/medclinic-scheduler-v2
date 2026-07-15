import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardShell } from "./DashboardShell";

const usePathname = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => usePathname(),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

const user = {
  userId: "1",
  fullName: "System Admin",
  email: "admin@example.com",
  role: "ADMIN" as const,
};

describe("DashboardShell", () => {
  beforeEach(() => usePathname.mockReturnValue("/appointments/appointment-123"));

  it("shows an accessible link back to the appointments list on appointment details", () => {
    render(<DashboardShell user={user}>Appointment details</DashboardShell>);

    expect(screen.getByRole("link", { name: "Back to appointments" })).toHaveAttribute("href", "/appointments");
  });

  it("shows an accessible link back to the students list on student details", () => {
    usePathname.mockReturnValue("/students/DEMO-0001");

    render(<DashboardShell user={user}>Student details</DashboardShell>);

    expect(screen.getByRole("link", { name: "Back to students" })).toHaveAttribute("href", "/students");
  });

  it.each([
    "/students/schedule-imports/new",
    "/students/schedule-imports/import-123",
  ])("shows an accessible link back to schedule imports on %s", (pathname) => {
    usePathname.mockReturnValue(pathname);

    render(<DashboardShell user={user}>Schedule import</DashboardShell>);

    expect(screen.getByRole("link", { name: "Back to schedule imports" })).toHaveAttribute(
      "href",
      "/students?view=schedule-imports",
    );
  });

  it("shows an accessible link back to coordinator schedules on batch details", () => {
    usePathname.mockReturnValue("/coordinator-schedules/batch-123");

    render(<DashboardShell user={user}>Batch details</DashboardShell>);

    expect(screen.getByRole("link", { name: "Back to coordinator schedules" })).toHaveAttribute(
      "href",
      "/coordinator-schedules",
    );
  });

  it.each([
    "/appointments",
    "/students",
    "/coordinator-schedules",
    "/students/new",
    "/coordinator-schedules/new",
    "/students/DEMO-0001/history",
    "/coordinator-schedules/batch-123/items",
    "/results/result-123",
  ])("does not show a back link on %s", (pathname) => {
    usePathname.mockReturnValue(pathname);

    render(<DashboardShell user={user}>Dashboard content</DashboardShell>);

    expect(screen.queryByRole("link", { name: /^Back to / })).not.toBeInTheDocument();
  });

  it("labels coordinator sessions distinctly", () => {
    render(
      <DashboardShell user={{
        userId: "3",
        fullName: "Schedule Coordinator",
        email: "coordinator@example.com",
        role: "COORDINATOR",
      }}>
        Coordinator content
      </DashboardShell>,
    );

    expect(screen.getByText("Coordinator")).toBeVisible();
  });
});
