import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders the CPU gold accent treatment", () => {
    render(<Button variant="accent">Find my schedule</Button>);

    expect(screen.getByRole("button", { name: "Find my schedule" })).toHaveClass(
      "bg-cpu-gold",
      "text-cpu-navy",
      "whitespace-nowrap",
    );
  });

  it("renders an exact square control for icon-only actions", () => {
    render(<Button size="icon" aria-label="Delete college">X</Button>);

    expect(screen.getByRole("button", { name: "Delete college" })).toHaveClass(
      "h-9",
      "w-9",
      "shrink-0",
      "p-0",
    );
  });
});
