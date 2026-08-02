import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { listAcademicYears, requireUser } = vi.hoisted(() => ({
  listAcademicYears: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/academic-years.service", () => ({ listAcademicYears }));

import AcademicYearsPage from "./page";

describe("AcademicYearsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-id", role: "ADMIN" });
    listAcademicYears.mockResolvedValue([{
      startYear: 2025,
      label: "2025–2026",
      closingDate: "2026-07-31",
      state: "OPEN",
      linkedSnapshotCount: 0,
    }]);
  });

  it("authorizes an administrator and renders the academic-year controls", async () => {
    render(await AcademicYearsPage());
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listAcademicYears).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { level: 1, name: "Academic years" })).toBeVisible();
    expect(screen.getByText("2025–2026")).toBeVisible();
  });

  it("denies a non-administrator before reading academic years", async () => {
    const error = new AppError("FORBIDDEN", "Forbidden", 403);
    requireUser.mockRejectedValue(error);
    await expect(AcademicYearsPage()).rejects.toBe(error);
    expect(listAcademicYears).not.toHaveBeenCalled();
  });
});
