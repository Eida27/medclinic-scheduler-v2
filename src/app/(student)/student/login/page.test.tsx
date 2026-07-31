import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { optionalStudent } = vi.hoisted(() => ({ optionalStudent: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/server/auth/current-student", () => ({ optionalStudent }));

import StudentLoginPage from "./page";

describe("StudentLoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    optionalStudent.mockResolvedValue(null);
  });

  it("explains that the portal supports appointments and result uploads", async () => {
    render(await StudentLoginPage());

    expect(screen.getByRole("heading", { name: "Student sign in" })).toBeVisible();
    expect(screen.getByText(
      "Sign in to view your appointments and upload your laboratory and physical examination results.",
    )).toBeVisible();
  });
});
