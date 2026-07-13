import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const usePathname = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => usePathname(),
}));

describe("Sidebar", () => {
  beforeEach(() => usePathname.mockReturnValue("/appointments"));

  it("pins the sidebar to the viewport only on desktop", () => {
    render(
      <Sidebar user={{ userId: "1", fullName: "Clinic User", email: "clinic@example.com", role: "CLINIC_STAFF" }} />,
    );

    expect(screen.getByRole("complementary")).toHaveClass(
      "lg:sticky",
      "lg:top-0",
      "lg:h-screen",
      "lg:self-start",
      "lg:overflow-y-auto",
    );
  });

  it("marks the active destination for assistive technology", () => {
    render(
      <Sidebar user={{ userId: "1", fullName: "Clinic User", email: "clinic@example.com", role: "CLINIC_STAFF" }} />,
    );

    expect(screen.getByRole("link", { name: "Appointments" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Laboratory" })).toHaveAttribute("href", "/laboratory");
    expect(screen.getByRole("link", { name: "Physical exam" })).toHaveAttribute("href", "/physical-exam");
    expect(screen.getByRole("link", { name: "Students & Schedules" })).toHaveAttribute("href", "/students");
    expect(screen.queryByRole("link", { name: "Compliance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Students" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Coordinator schedules" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Dashboard navigation" })).toHaveClass("scrollbar-none");
  });

  it("keeps a parent destination active on detail routes", () => {
    usePathname.mockReturnValue("/appointments/appointment-123");

    render(
      <Sidebar user={{ userId: "1", fullName: "Clinic User", email: "clinic@example.com", role: "CLINIC_STAFF" }} />,
    );

    expect(screen.getByRole("link", { name: "Appointments" })).toHaveAttribute("aria-current", "page");
  });

  it("shows administration destinations only to administrators", () => {
    const { rerender } = render(
      <Sidebar user={{ userId: "1", fullName: "Clinic User", email: "clinic@example.com", role: "CLINIC_STAFF" }} />,
    );

    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();

    rerender(
      <Sidebar user={{ userId: "2", fullName: "Admin User", email: "admin@example.com", role: "ADMIN" }} />,
    );

    expect(screen.getByRole("link", { name: "Users" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Reference data" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Capacity" })).toBeVisible();
  });
});
