import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { optionalStudent } = vi.hoisted(() => ({ optionalStudent: vi.fn() }));
vi.mock("@/server/auth/current-student", () => ({ optionalStudent }));
vi.mock("@/components/branding/BrandMark", () => ({ BrandMark: () => <span>MedClinic</span> }));
vi.mock("@/components/student/StudentLogoutButton", () => ({
  StudentLogoutButton: () => <button>Log out</button>,
}));

import StudentLayout from "./layout";

describe("StudentLayout", () => {
  beforeEach(() => vi.resetAllMocks());

  it("exposes only mandatory verification and logout while onboarding is incomplete", async () => {
    optionalStudent.mockResolvedValue({ email: null, emailVerifiedAt: null });
    render(await StudentLayout({ children: <p>Onboarding</p> }));

    expect(screen.getByRole("link", { name: "Email verification" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Log out" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Schedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Results" })).not.toBeInTheDocument();
  });
});
