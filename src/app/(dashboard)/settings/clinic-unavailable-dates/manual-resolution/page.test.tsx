import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/components/settings/ManualResolutionQueue", () => ({
  ManualResolutionQueue: () => <div>Manual queue</div>,
}));

import ManualResolutionPage from "./page";

describe("ManualResolutionPage", () => {
  it("is administrator-only and renders the queue", async () => {
    requireUser.mockResolvedValue({ userId: "admin", role: "ADMIN" });
    render(await ManualResolutionPage());
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(screen.getByRole("heading", { name: "Manual Resolution Required" })).toBeVisible();
    expect(screen.getByText("Manual queue")).toBeVisible();
  });
});
