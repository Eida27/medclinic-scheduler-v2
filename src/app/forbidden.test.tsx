import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Forbidden from "./forbidden";

describe("Forbidden", () => {
  it("renders a safe access-denied response without email-delivery controls", () => {
    render(<Forbidden />);

    expect(screen.getByRole("heading", { level: 1, name: "Access denied" })).toBeVisible();
    expect(screen.getByText("You do not have permission to view this page.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /retry|queue current/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/smtp|verification token|fingerprint/i)).not.toBeInTheDocument();
  });
});
