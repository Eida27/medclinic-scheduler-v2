import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { listAcademicYears, notFound, requireUser } = vi.hoisted(() => ({
  listAcademicYears: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound,
  useRouter: () => ({ refresh: vi.fn() }),
}));
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

  it.each(["COORDINATOR", "CLINIC_STAFF"])(
    "cleanly denies %s before reading academic years",
    async (role) => {
      requireUser.mockRejectedValue(new AppError("FORBIDDEN", `${role} is forbidden`, 403));

      await expect(AcademicYearsPage()).rejects.toThrow("NEXT_NOT_FOUND");

      expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
      expect(notFound).toHaveBeenCalledOnce();
      expect(listAcademicYears).not.toHaveBeenCalled();
    },
  );
});
