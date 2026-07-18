// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, acceptAndScheduleImport, listScheduleImports } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  acceptAndScheduleImport: vi.fn(),
  listScheduleImports: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({
  acceptAndScheduleImport,
  listScheduleImports,
}));

import { GET, POST } from "./route";

const admin = { userId: "admin-user", role: "ADMIN" as const };

describe("/api/schedule-imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    listScheduleImports.mockResolvedValue([{ importId: "import-id", status: "PUBLISHED" }]);
    acceptAndScheduleImport.mockResolvedValue({
      outcome: "PUBLISHED",
      importId: "import-id",
      status: "PUBLISHED",
      totalRows: 1,
      insertedStudentCount: 1,
      updatedStudentCount: 0,
      skippedStudentCount: 0,
      laboratoryItemCount: 1,
      physicalExaminationItemCount: 1,
      publishedAppointmentCount: 2,
      generatedRange: { startDate: "2026-08-03", endDate: "2026-08-04" },
      overflow: { pairCountBeyondPreferredWindow: 0, unscheduledStudentCount: 0 },
      displacementTotal: 0,
      batchIds: ["lab-batch", "pe-batch"],
    });
  });

  it("lists imports for administrators and coordinators", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{ importId: "import-id", status: "PUBLISHED" }],
    });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
  });

  it("passes the academic-year metadata and CSV bytes to atomic scheduling", async () => {
    const contents = [
      "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth",
      "23-0001-01,Santos,Maria,,,College of Computer Studies,BSIT,3,05-06-2003",
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([contents], "students.csv", { type: "text/csv" }));
    form.set("studentCategory", "OJT");
    form.set("academicYearStart", "2026");
    form.set("preferredMonth", "9");

    const response = await POST(new Request("http://localhost/api/schedule-imports", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        outcome: "PUBLISHED",
        insertedStudentCount: 1,
        publishedAppointmentCount: 2,
        generatedRange: { startDate: "2026-08-03", endDate: "2026-08-04" },
      },
    });
    const [input, actor] = acceptAndScheduleImport.mock.calls[0];
    expect({ ...input, contents: Array.from(input.contents) }).toEqual({
      fileName: "students.csv",
      fileSize: Buffer.byteLength(contents),
      contents: Array.from(new TextEncoder().encode(contents)),
      studentCategory: "OJT",
      academicYearStart: "2026",
      preferredMonth: "9",
    });
    expect(actor).toEqual(admin);
  });

  it("rejects a missing file without calling the service", async () => {
    const response = await POST(new Request("http://localhost/api/schedule-imports", {
      method: "POST",
      body: new FormData(),
    }));
    expect(response.status).toBe(422);
    expect(acceptAndScheduleImport).not.toHaveBeenCalled();
  });

  it("requires an import operator", async () => {
    requireUser.mockRejectedValue(new AppError("FORBIDDEN", "Forbidden", 403));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(listScheduleImports).not.toHaveBeenCalled();
  });
});
