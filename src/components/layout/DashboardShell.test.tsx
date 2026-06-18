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

  it("does not show the back link on the appointments list", () => {
    usePathname.mockReturnValue("/appointments");

    render(<DashboardShell user={user}>Appointments</DashboardShell>);

    expect(screen.queryByRole("link", { name: "Back to appointments" })).not.toBeInTheDocument();
  });

  it("does not show the back link on unrelated dashboard routes", () => {
    usePathname.mockReturnValue("/students/student-123");

    render(<DashboardShell user={user}>Student details</DashboardShell>);

    expect(screen.queryByRole("link", { name: "Back to appointments" })).not.toBeInTheDocument();
  });
});
