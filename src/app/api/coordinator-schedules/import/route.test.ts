// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, importCoordinatorScheduleCsv } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  importCoordinatorScheduleCsv: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/coordinator-schedules.service", () => ({ importCoordinatorScheduleCsv }));

import { POST } from "./route";

describe("POST /api/coordinator-schedules/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "staff-user", role: "CLINIC_STAFF" });
    importCoordinatorScheduleCsv.mockResolvedValue({
      id: "batch-id",
      status: "DRAFT",
      itemCount: 1,
      createdStudentCount: 1,
    });
  });

  it("imports an authenticated multipart CSV upload", async () => {
    const contents = [
      "Student ID,Name,College,Course,Year,Appointment Date,Appointment Type",
      "23-0001-01,Maria Santos,College of Computer Studies,BSIT,3,06-19-2026,Laboratory",
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([contents], "appointments.csv", { type: "text/csv" }));
    form.set("batchName", "June coordinator schedule");
    form.set("priorityGroupId", "30000000-0000-4000-8000-000000000004");
    form.set("submittedByName", "CCS Coordinator");
    form.set("description", "Imported schedule");

    const response = await POST(new Request("http://localhost/api/coordinator-schedules/import", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: { id: "batch-id", status: "DRAFT", itemCount: 1, createdStudentCount: 1 },
    });
    expect(importCoordinatorScheduleCsv).toHaveBeenCalledWith({
      fileName: "appointments.csv",
      fileSize: contents.length,
      contents,
      batchName: "June coordinator schedule",
      priorityGroupId: "30000000-0000-4000-8000-000000000004",
      submittedByName: "CCS Coordinator",
      description: "Imported schedule",
    }, "staff-user");
  });

  it("returns a field error when no CSV file is supplied", async () => {
    const response = await POST(new Request("http://localhost/api/coordinator-schedules/import", {
      method: "POST",
      body: new FormData(),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CSV_IMPORT_INVALID",
        message: "Choose a CSV file to import.",
        fields: { file: ["Choose a CSV file to import."] },
      },
    });
  });
});
