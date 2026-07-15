import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StudentsSchedulesTabs } from "./StudentsSchedulesTabs";

describe("StudentsSchedulesTabs", () => {
  it("offers both workspace views to administrators", () => {
    render(<StudentsSchedulesTabs activeView="schedule-imports" canManageImports />);

    expect(screen.getByRole("link", { name: "Students" })).toHaveAttribute("href", "/students");
    expect(screen.getByRole("link", { name: "Schedule Imports" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("does not expose schedule imports to clinic staff", () => {
    render(<StudentsSchedulesTabs activeView="students" canManageImports={false} />);

    expect(screen.getByRole("link", { name: "Students" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Schedule Imports" })).not.toBeInTheDocument();
  });

  it("offers schedule imports to coordinators through the shared permission", () => {
    render(<StudentsSchedulesTabs activeView="schedule-imports" canManageImports />);

    expect(screen.getByRole("link", { name: "Schedule Imports" })).toHaveAttribute("aria-current", "page");
  });
});
