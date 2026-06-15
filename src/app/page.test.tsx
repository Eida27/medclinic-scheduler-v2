import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("renders the university service heading and actions without capacity copy", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", {
      level: 1,
      name: "Central Philippine University Laboratory and Physical Examination",
    })).toBeVisible();
    expect(screen.getByRole("img", { name: "Central Philippine University seal" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Find my schedule" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open staff dashboard" })).toBeVisible();
    expect(screen.queryByText("Clinic scheduling and compliance")).not.toBeInTheDocument();
    expect(screen.queryByText("Organize coordinator submissions, publish validated appointments, and track physical examination and laboratory completion in one focused system.")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommended daily capacity per service")).not.toBeInTheDocument();
    expect(screen.queryByText("Maximum before admin override")).not.toBeInTheDocument();
    expect(screen.queryByText("Independent physical and laboratory tracks")).not.toBeInTheDocument();
  });
});
