import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { optionalStudent } = vi.hoisted(() => ({ optionalStudent: vi.fn() }));
vi.mock("@/server/auth/current-student", () => ({ optionalStudent }));
vi.mock("@/components/branding/BrandMark", () => ({ BrandMark: () => <span>MedClinic</span> }));
vi.mock("@/components/layout/ManilaBoundaryRefresh", () => ({ ManilaBoundaryRefresh: () => null }));
vi.mock("@/components/student/StudentLogoutButton", () => ({
  StudentLogoutButton: () => <button>Log out</button>,
}));

import StudentLayout from "./layout";

describe("StudentLayout", () => {
  beforeEach(() => vi.resetAllMocks());

  it("exposes reading navigation and logout before email verification", async () => {
    optionalStudent.mockResolvedValue({ email: null, emailVerifiedAt: null });
    render(await StudentLayout({ children: <p>Onboarding</p> }));

    expect(screen.getByRole("link", { name: "Email verification" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Log out" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute("href", "/student");
    expect(screen.getByRole("link", { name: "Notifications" })).toHaveAttribute("href", "/student/notifications");
    expect(screen.getByRole("link", { name: "Results" })).toHaveAttribute("href", "/student/results");
  });
});
