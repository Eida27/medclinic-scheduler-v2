// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@/lib/errors";

const { requireUser, preflightScheduleImport } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  preflightScheduleImport: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({ preflightScheduleImport }));

import { POST } from "./route";

const admin = { userId: "admin-user", role: "ADMIN" as const };

function validForm() {
  const contents = [
    "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
    "23-0001-01,Santos,Maria,Rosa,,College of Computer Studies,BSIT,3,2003-05-06",
  ].join("\n");
  const form = new FormData();
  form.set("file", new File([contents], "students.csv", { type: "text/csv" }));
  form.set("importMode", "STANDARD");
  form.set("studentCategory", "REGULAR");
  form.set("academicYearStart", "2026");
  return { contents, form };
}

describe("POST /api/schedule-imports/preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    preflightScheduleImport.mockResolvedValue({ valid: true });
  });

  it("returns a non-mutating success for authorized multipart input", async () => {
    const { contents, form } = validForm();
    const response = await POST(new Request("http://localhost/api/schedule-imports/preflight", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { valid: true } });
    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    expect(preflightScheduleImport).toHaveBeenCalledWith({
      fileName: "students.csv",
      fileSize: Buffer.byteLength(contents),
      contents: expect.any(Uint8Array),
      importMode: "STANDARD",
      studentCategory: "REGULAR",
      academicYearStart: "2026",
      preferredMonth: null,
      firstYearLaboratoryDate: null,
    }, admin);
  });

  it("rejects a missing file without running preflight", async () => {
    const response = await POST(new Request("http://localhost/api/schedule-imports/preflight", {
      method: "POST",
      body: new FormData(),
    }));

    expect(response.status).toBe(422);
    expect(preflightScheduleImport).not.toHaveBeenCalled();
  });

  it("requires an import operator", async () => {
    requireUser.mockRejectedValue(new AppError("FORBIDDEN", "Forbidden", 403));
    const response = await POST(new Request("http://localhost/api/schedule-imports/preflight", {
      method: "POST",
      body: validForm().form,
    }));

    expect(response.status).toBe(403);
    expect(preflightScheduleImport).not.toHaveBeenCalled();
  });

  it("returns retired categories as a Student category field error", async () => {
    const validation = z.object({
      studentCategory: z.enum(["REGULAR", "OJT", "TOUR"]),
    }).safeParse({ studentCategory: "SPECIALIZED" });
    if (validation.success) throw new Error("Expected the retired category to fail validation.");
    preflightScheduleImport.mockRejectedValue(validation.error);
    const { form } = validForm();
    form.set("studentCategory", "SPECIALIZED");

    const response = await POST(new Request("http://localhost/api/schedule-imports/preflight", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        fields: { studentCategory: [expect.any(String)] },
      },
    });
  });
});
