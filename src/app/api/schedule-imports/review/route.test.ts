// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, reviewFirstYearScheduleImport } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  reviewFirstYearScheduleImport: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({
  reviewFirstYearScheduleImport,
}));

import { POST } from "./route";

const admin = { userId: "admin-user", role: "ADMIN" as const };

describe("POST /api/schedule-imports/review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    reviewFirstYearScheduleImport.mockResolvedValue({
      sourceFilename: "first-year.csv",
      memberCount: 1,
      canPublish: true,
    });
  });

  it("forwards the original First Year multipart submission for non-mutating review", async () => {
    const contents = [
      "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
      "26-0001-01,Santos,Maria,Rosa,,College of Computer Studies,BSIT,1,2007-05-06",
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([contents], "first-year.csv", { type: "text/csv" }));
    form.set("importMode", "FIRST_YEAR_OVPSA");
    form.set("studentCategory", "REGULAR");
    form.set("academicYearStart", "2026");
    form.set("firstYearLaboratoryDate", "2026-09-14");

    const response = await POST(new Request("http://localhost/api/schedule-imports/review", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { sourceFilename: "first-year.csv", memberCount: 1, canPublish: true },
    });
    expect(reviewFirstYearScheduleImport).toHaveBeenCalledWith(expect.objectContaining({
      fileName: "first-year.csv",
      fileSize: Buffer.byteLength(contents),
      importMode: "FIRST_YEAR_OVPSA",
      studentCategory: "REGULAR",
      academicYearStart: "2026",
      preferredMonth: null,
      firstYearLaboratoryDate: "2026-09-14",
    }), admin);
  });
});
