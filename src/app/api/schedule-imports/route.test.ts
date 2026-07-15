// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { requireUser, importAndPublishStudentScheduleCsv, listScheduleImports } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  importAndPublishStudentScheduleCsv: vi.fn(),
  listScheduleImports: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({
  importAndPublishStudentScheduleCsv,
  listScheduleImports,
}));

import { GET, POST } from "./route";

const admin = { userId: "admin-user", role: "ADMIN" as const };
const coordinator = { userId: "coordinator-user", role: "COORDINATOR" as const };

describe("/api/schedule-imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    listScheduleImports.mockResolvedValue([{ id: "import-id", status: "DRAFT" }]);
    importAndPublishStudentScheduleCsv.mockResolvedValue({
      outcome: "PUBLISHED",
      importId: "import-id",
      status: "PUBLISHED",
      totalRows: 1,
      createdStudentCount: 1,
      matchedStudentCount: 0,
      appointmentCount: 2,
      publishedAppointmentCount: 2,
    });
  });

  it("lists grouped imports for import operators", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{ id: "import-id", status: "DRAFT" }],
    });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    expect(listScheduleImports).toHaveBeenCalledWith(admin);
  });

  it("passes only multipart file bytes and priority to automatic publishing", async () => {
    const contents = [
      "Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule",
      '23-0001-01,"Santos, Maria",College of Computer Studies,BSIT,3,06-19-2026,06-20-2026',
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([contents], "appointments.csv", { type: "text/csv" }));
    form.set("priorityGroupId", "30000000-0000-4000-8000-000000000004");

    const response = await POST(new Request("http://localhost/api/schedule-imports", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: {
        outcome: "PUBLISHED",
        importId: "import-id",
        status: "PUBLISHED",
        totalRows: 1,
        createdStudentCount: 1,
        matchedStudentCount: 0,
        appointmentCount: 2,
        publishedAppointmentCount: 2,
      },
    });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    expect(importAndPublishStudentScheduleCsv).toHaveBeenCalledTimes(1);
    const [input, actor] = importAndPublishStudentScheduleCsv.mock.calls[0];
    expect({ ...input, contents: Array.from(input.contents) }).toEqual({
      fileName: "appointments.csv",
      fileSize: contents.length,
      contents: Array.from(new TextEncoder().encode(contents)),
      priorityGroupId: "30000000-0000-4000-8000-000000000004",
    });
    expect(actor).toEqual(admin);
  });

  it("returns a created review checkpoint without converting it to an API error", async () => {
    requireUser.mockResolvedValue(coordinator);
    importAndPublishStudentScheduleCsv.mockResolvedValue({
      outcome: "REVIEW_REQUIRED",
      importId: "import-id",
      status: "VALIDATED",
      stage: "GENERATE",
      issue: {
        code: "ADMIN_OVERRIDE_REQUIRED",
        message: "An administrator must approve capacity conflicts.",
      },
    });
    const form = new FormData();
    form.set("file", new File(["csv"], "appointments.csv", { type: "text/csv" }));
    form.set("priorityGroupId", "30000000-0000-4000-8000-000000000004");

    const response = await POST(new Request("http://localhost/api/schedule-imports", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        outcome: "REVIEW_REQUIRED",
        importId: "import-id",
        status: "VALIDATED",
        stage: "GENERATE",
      },
    });
    expect(importAndPublishStudentScheduleCsv).toHaveBeenCalledWith(expect.any(Object), coordinator);
  });

  it("requires an import operator for both collection operations", async () => {
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
    expect(requireUser.mock.calls).toEqual([
      [["ADMIN", "COORDINATOR"]],
      [["ADMIN", "COORDINATOR"]],
    ]);
    expect(listScheduleImports).not.toHaveBeenCalled();
    expect(importAndPublishStudentScheduleCsv).not.toHaveBeenCalled();
  });
});
