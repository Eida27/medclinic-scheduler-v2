import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the light landing page content and navigation actions", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", {
      level: 1,
      name: "Central Philippine University Laboratory and Physical Examination",
    })).toBeVisible();
    expect(screen.getByRole("img", { name: "Central Philippine University seal" })).toBeVisible();
    expect(screen.queryByText("Easy access to your clinic schedule. Safe, organized, and built for the CPU community.")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Medical scheduling illustration" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Service benefits" })).not.toBeInTheDocument();
    expect(screen.queryByText("Published schedules")).not.toBeInTheDocument();
    expect(screen.queryByText("Secure & private")).not.toBeInTheDocument();
    expect(screen.queryByText("For CPU students")).not.toBeInTheDocument();
    expect(screen.getByText("Student sign in").closest("a")).toHaveAttribute("href", "/student/login");
    expect(screen.getByText("View your schedule and submit results.")).toBeVisible();
    expect(screen.getByText("Staff sign in").closest("a")).toHaveAttribute("href", "/login");
    expect(screen.getByText("For administrators, coordinators and clinic staff.")).toBeVisible();
    expect(screen.getAllByText("Student sign in")).toHaveLength(1);
    expect(screen.getAllByText("Staff sign in")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Find my schedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open staff dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByText("Clinic scheduling and compliance")).not.toBeInTheDocument();
    expect(screen.queryByText("Organize coordinator submissions, publish validated appointments, and track physical examination and laboratory completion in one focused system.")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommended daily capacity per service")).not.toBeInTheDocument();
    expect(screen.queryByText("Maximum before admin override")).not.toBeInTheDocument();
    expect(screen.queryByText("Independent physical and laboratory tracks")).not.toBeInTheDocument();
  });
});
