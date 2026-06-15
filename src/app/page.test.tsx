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
    expect(screen.getByRole("link", { name: "Staff sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Find my schedule" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Find my schedule" })).toHaveAttribute("href", "/student-lookup");
    expect(screen.getByRole("link", { name: "Open staff dashboard" })).toHaveAttribute("href", "/login");
    expect(screen.queryByText("Clinic scheduling and compliance")).not.toBeInTheDocument();
    expect(screen.queryByText("Organize coordinator submissions, publish validated appointments, and track physical examination and laboratory completion in one focused system.")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommended daily capacity per service")).not.toBeInTheDocument();
    expect(screen.queryByText("Maximum before admin override")).not.toBeInTheDocument();
    expect(screen.queryByText("Independent physical and laboratory tracks")).not.toBeInTheDocument();
  });
});
