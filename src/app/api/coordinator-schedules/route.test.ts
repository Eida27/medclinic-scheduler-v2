// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/server/db/pool";

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));

import { POST } from "./route";

describe("POST /api/coordinator-schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({
      userId: "00000000-0000-4000-8000-000000000001",
      role: "ADMIN",
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns row-specific validation when a student is not registered", async () => {
    const batchName = "Missing student route integration";
    const response = await POST(new Request("http://localhost/api/coordinator-schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchName,
        collegeId: "10000000-0000-4000-8000-000000000003",
        programId: "20000000-0000-4000-8000-000000000003",
        submittedByName: "Test",
        description: "Must not persist",
        items: [{
          studentNumber: "09-0808-97",
          scheduleType: "BOTH",
          priorityGroupId: "30000000-0000-4000-8000-000000000004",
          targetDate: null,
          targetWeekStart: "2026-06-20",
          targetWeekEnd: "2026-06-27",
          remarks: "",
        }],
      }),
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "SCHEDULE_STUDENTS_NOT_FOUND",
        message: "Some students are not registered. Add them before creating the batch, or use CSV import.",
        fields: {
          "items.0.studentNumber": ["Student number 09-0808-97 is not registered."],
        },
      },
    });
    const batches = await pool.query("SELECT 1 FROM schedule_batches WHERE batch_name=$1", [batchName]);
    expect(batches.rowCount).toBe(0);
  });
});
