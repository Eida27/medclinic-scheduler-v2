import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("renders the CPU seal and full clinic identity", () => {
    render(<BrandMark priority />);

    expect(screen.getByRole("img", { name: "Central Philippine University seal" })).toBeVisible();
    expect(screen.getByText("MedClinic Scheduler")).toBeVisible();
    expect(screen.getByText("CPU Health Services")).toBeVisible();
  });

  it("supports a compact inverse presentation", () => {
    const { container } = render(<BrandMark compact inverse />);

    expect(screen.getByRole("img", { name: "Central Philippine University seal" })).toBeVisible();
    expect(screen.queryByText("MedClinic Scheduler")).not.toBeInTheDocument();
    expect(container.firstChild).toHaveClass("text-white");
  });
});
