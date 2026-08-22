import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  forbidden: vi.fn(() => { throw new Error("NEXT_FORBIDDEN"); }),
  optionalStudent: vi.fn(),
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({ forbidden: mocks.forbidden, redirect: mocks.redirect }));
vi.mock("@/server/auth/current-student", () => ({ optionalStudent: mocks.optionalStudent }));
vi.mock("@/server/auth/current-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/components/layout/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <section aria-label="dashboard">{children}</section>,
}));

import ProtectedLayout from "./layout";

describe("ProtectedLayout authorization boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the staff dashboard for an administrator", async () => {
    mocks.requireUser.mockResolvedValue({ userId: "admin", role: "ADMIN" });
    render(await ProtectedLayout({ children: <p>Administrator content</p> }));

    expect(screen.getByLabelText("dashboard")).toHaveTextContent("Administrator content");
    expect(mocks.optionalStudent).not.toHaveBeenCalled();
  });

  it("returns forbidden for an authenticated student and renders no dashboard controls", async () => {
    mocks.requireUser.mockRejectedValue(new AppError("UNAUTHENTICATED", "Staff only.", 401));
    mocks.optionalStudent.mockResolvedValue({ studentNumber: "2026-00001" });

    await expect(ProtectedLayout({ children: <button>Retry delivery</button> })).rejects.toThrow("NEXT_FORBIDDEN");
    expect(mocks.forbidden).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry delivery" })).not.toBeInTheDocument();
  });

  it("redirects an anonymous visitor to login", async () => {
    mocks.requireUser.mockRejectedValue(new AppError("UNAUTHENTICATED", "Please sign in.", 401));
    mocks.optionalStudent.mockResolvedValue(null);

    await expect(ProtectedLayout({ children: <button>Retry delivery</button> })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
    expect(mocks.forbidden).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry delivery" })).not.toBeInTheDocument();
  });

  it("redirects invalid staff sessions without treating them as students", async () => {
    mocks.requireUser.mockRejectedValue(new Error("Invalid session"));

    await expect(ProtectedLayout({ children: <p>Private</p> })).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.optionalStudent).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });
});
