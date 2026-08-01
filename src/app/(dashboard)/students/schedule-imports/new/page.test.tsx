import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
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

async function readArtifactWorkbook(templatePath: string) {
  const zip = await JSZip.loadAsync(readFileSync(templatePath));
  const xmlEntries = Object.keys(zip.files).filter((name) => name.endsWith(".xml"));

  await Promise.all(xmlEntries.map(async (name) => {
    const entry = zip.file(name);
    if (!entry) return;
    const xml = await entry.async("string");
    if (!xml.includes("<x:")) return;
    zip.file(name, xml
      .replaceAll("<x:", "<")
      .replaceAll("</x:", "</")
      .replace(
        'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      ));
  }));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await zip.generateAsync({ type: "nodebuffer" }));
  return workbook;
}

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

  it("ships an exact two-row, non-private BSIT Excel template", async () => {
    const templatePath = path.join(
      process.cwd(),
      "public",
      "templates",
      "student-schedule-import-template.xlsx",
    );

    expect(existsSync(templatePath)).toBe(true);
    if (!existsSync(templatePath)) return;

    const workbook = await readArtifactWorkbook(templatePath);

    expect(workbook.worksheets).toHaveLength(1);
    const worksheet = workbook.worksheets[0];
    expect(worksheet.name).toBe("Student Import");
    expect(worksheet.state).toBe("visible");
    expect(worksheet.actualRowCount).toBe(2);
    expect(worksheet.actualColumnCount).toBe(9);
    expect(worksheet.getRow(1).values).toEqual([
      undefined,
      "Student ID",
      "Surname",
      "First Name",
      "Middle Name",
      "Suffix",
      "College",
      "Course",
      "Year",
      "Date of Birth",
    ]);
    expect(worksheet.getRow(2).values).toEqual([
      undefined,
      "23-1212-97",
      "Abad",
      "Aaron Miguel",
      "Abella",
      undefined,
      "College of Computer Studies",
      "BSIT",
      3,
      expect.any(Date),
    ]);
    expect(worksheet.getCell("A2").numFmt).toBe("@");
    expect((worksheet.getCell("I2").value as Date).toISOString().slice(0, 10)).toBe("2004-08-04");
    expect(worksheet.getCell("I2").numFmt).toBe("yyyy-mm-dd");
    expect(worksheet.getCell("A1").font).toMatchObject({ name: "Arial", size: 11, bold: true });
    expect(worksheet.getCell("A1").alignment).toMatchObject({ horizontal: "center", vertical: "middle" });
    expect(worksheet.getCell("A1").border.top?.style).toBe("thin");
    expect(worksheet.getCell("I2").alignment.horizontal).toBe("center");
    expect(worksheet.columns.map((column) => column.width)).toEqual([
      15.5,
      16.25,
      20.25,
      20,
      10.5,
      37.5,
      12.5,
      9,
      16.5,
    ]);

    worksheet.eachRow((row) => row.eachCell({ includeEmpty: false }, (cell) => {
      expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
    }));
  });
});
