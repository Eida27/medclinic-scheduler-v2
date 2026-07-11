// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, importStudentScheduleCsv, listScheduleImports } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  importStudentScheduleCsv: vi.fn(),
  listScheduleImports: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({
  importStudentScheduleCsv,
  listScheduleImports,
}));

import { GET, POST } from "./route";

const admin = { userId: "admin-user", role: "ADMIN" as const };

describe("/api/schedule-imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    listScheduleImports.mockResolvedValue([{ id: "import-id", status: "DRAFT" }]);
    importStudentScheduleCsv.mockResolvedValue({
      importId: "import-id",
      status: "DRAFT",
      totalRows: 1,
      batchIds: ["laboratory-batch-id", "physical-batch-id"],
      createdStudentCount: 1,
      matchedStudentCount: 0,
      laboratoryItemCount: 1,
      physicalExaminationItemCount: 1,
    });
  });

  it("lists grouped imports for ADMIN users", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{ id: "import-id", status: "DRAFT" }],
    });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listScheduleImports).toHaveBeenCalledWith(admin);
  });

  it("passes multipart file bytes and metadata to grouped import", async () => {
    const contents = [
      "Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule",
      '23-0001-01,"Santos, Maria",College of Computer Studies,BSIT,3,06-19-2026,06-20-2026',
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([contents], "appointments.csv", { type: "text/csv" }));
    form.set("importName", "June grouped schedule");
    form.set("priorityGroupId", "30000000-0000-4000-8000-000000000004");
    form.set("submittedByName", "CCS Coordinator");
    form.set("description", "Imported schedule");

    const response = await POST(new Request("http://localhost/api/schedule-imports", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: {
        importId: "import-id",
        status: "DRAFT",
        totalRows: 1,
        batchIds: ["laboratory-batch-id", "physical-batch-id"],
        createdStudentCount: 1,
        matchedStudentCount: 0,
        laboratoryItemCount: 1,
        physicalExaminationItemCount: 1,
      },
    });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(importStudentScheduleCsv).toHaveBeenCalledTimes(1);
    const [input, actor] = importStudentScheduleCsv.mock.calls[0];
    expect({ ...input, contents: Array.from(input.contents) }).toEqual({
      fileName: "appointments.csv",
      fileSize: contents.length,
      contents: Array.from(new TextEncoder().encode(contents)),
      importName: "June grouped schedule",
      priorityGroupId: "30000000-0000-4000-8000-000000000004",
      submittedByName: "CCS Coordinator",
      description: "Imported schedule",
    });
    expect(actor).toEqual(admin);
  });

  it("requires ADMIN for both collection operations", async () => {
    requireUser.mockRejectedValue(new AppError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    ));

    const getResponse = await GET();
    const postResponse = await POST(new Request("http://localhost/api/schedule-imports", {
      method: "POST",
      body: new FormData(),
    }));

    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(403);
    expect(requireUser.mock.calls).toEqual([[['ADMIN']], [['ADMIN']]]);
    expect(listScheduleImports).not.toHaveBeenCalled();
    expect(importStudentScheduleCsv).not.toHaveBeenCalled();
  });
});
