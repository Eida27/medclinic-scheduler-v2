import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPriorityGroups, requireUser, priorities } = vi.hoisted(() => ({
  listPriorityGroups: vi.fn(),
  requireUser: vi.fn(),
  priorities: [{
    id: "30000000-0000-4000-8000-000000000004",
    name: "Regular",
    rankOrder: 4,
    isActive: true,
  }],
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/reference-data.repository", () => ({ listPriorityGroups }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import NewScheduleImportPage from "./page";

describe("NewScheduleImportPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-user", role: "ADMIN" });
    listPriorityGroups.mockResolvedValue(priorities);
  });

  it("allows administrators and coordinators and renders the academic-year importer", async () => {
    render(await NewScheduleImportPage());

    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    expect(listPriorityGroups).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Import schedule CSV" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Academic-year student CSV" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Regular" })).toHaveValue("REGULAR");
    expect(screen.queryByText(/manual schedule encoder/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/legacy coordinator importer/i)).not.toBeInTheDocument();
  });

  it("does not load priority data when authorization fails", async () => {
    requireUser.mockRejectedValue(new Error("forbidden"));

    await expect(NewScheduleImportPage()).rejects.toThrow("forbidden");
    expect(listPriorityGroups).not.toHaveBeenCalled();
  });

  it("ships an exact two-row, non-private BSIT CSV template", () => {
    const templatePath = path.join(
      process.cwd(),
      "public",
      "templates",
      "student-schedule-import-template.csv",
    );

    expect(existsSync(templatePath)).toBe(true);
    if (!existsSync(templatePath)) return;

    expect(readFileSync(templatePath, "utf8").replaceAll("\r\n", "\n")).toBe([
      "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth",
      "23-1212-97,Abad,Aaron Miguel,A.,,College of Computer Studies,BSIT,3,08-04-2004",
      "",
    ].join("\n"));
  });
});
