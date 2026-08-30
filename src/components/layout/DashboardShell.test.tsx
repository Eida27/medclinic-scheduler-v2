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
  beforeEach(() => usePathname.mockReturnValue("/laboratory/appointment-123"));

  it("shows an accessible link back to Laboratory on its appointment details", () => {
    render(<DashboardShell user={user}>Appointment details</DashboardShell>);

    expect(screen.getByRole("link", { name: "Back to Laboratory" })).toHaveAttribute("href", "/laboratory");
  });

  it("shows an accessible link back to Physical Examination on its appointment details", () => {
    usePathname.mockReturnValue("/physical-exam/appointment-123");

    render(<DashboardShell user={user}>Appointment details</DashboardShell>);

    expect(screen.getByRole("link", { name: "Back to Physical Examination" })).toHaveAttribute("href", "/physical-exam");
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

  it.each([
    "/appointments",
    "/appointments/appointment-123",
    "/students",
    "/students/new",
    "/students/DEMO-0001/history",
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
