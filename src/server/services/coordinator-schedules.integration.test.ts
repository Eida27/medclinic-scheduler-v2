// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { addScheduleBatch, generateBatchAppointments, validateBatch } from "./coordinator-schedules.service";

const admin = {
  userId: "00000000-0000-4000-8000-000000000001",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};

afterAll(async () => {
  await pool.end();
});

describe("coordinator scheduling workflow", () => {
  it("classifies the seeded warning and conflict capacity fixtures", async () => {
    const warning = await validateBatch("50000000-0000-4000-8000-000000000130", admin.userId);
    const conflict = await validateBatch("50000000-0000-4000-8000-000000000160", admin.userId);

    expect(warning.summary.warningCount).toBe(130);
    expect(warning.summary.conflictCount).toBe(0);
    expect(conflict.summary.conflictCount).toBe(160);
  });

  it("limits capacity summaries to dates and services requested by the batch", async () => {
    const conflictBatchId = "50000000-0000-4000-8000-000000000160";
    const weekBatchId = "50000000-0000-4000-8000-000000000010";

    try {
      await generateBatchAppointments(conflictBatchId, admin, "Integration test capacity override.");
      const week = await validateBatch(weekBatchId, admin.userId);

      expect(week.summary.capacityResults).toHaveLength(10);
      expect(week.summary.capacityResults.every((result) => (
        result.date >= "2026-07-13" && result.date <= "2026-07-17"
      ))).toBe(true);
    } finally {
      await pool.query("DELETE FROM appointments WHERE batch_id=$1", [conflictBatchId]);
      await pool.query(
        `UPDATE schedule_batches
            SET status='DRAFT', override_reason=NULL, overridden_at=NULL, overridden_by=NULL,
                validated_at=NULL, validated_by=NULL, validation_summary=NULL
          WHERE id=$1`,
        [conflictBatchId],
      );
      await pool.query(
        "UPDATE coordinator_schedule_items SET status='PENDING', validation_issues='[]'::jsonb WHERE batch_id=$1",
        [conflictBatchId],
      );
    }
  });

  it("creates two draft appointments for BOTH and protects generation from repeats", async () => {
    const batch = await addScheduleBatch({
      batchName: "Automated integration batch",
      collegeId: "10000000-0000-4000-8000-000000000003",
      programId: "20000000-0000-4000-8000-000000000003",
      submittedByName: "Test",
      description: "Disposable integration fixture",
      items: [{
        studentNumber: "DEMO-0180",
        scheduleType: "BOTH",
        priorityGroupId: "30000000-0000-4000-8000-000000000004",
        targetDate: "2026-08-03",
        targetWeekStart: null,
        targetWeekEnd: null,
        remarks: "",
      }],
    }, admin.userId);
    const batchId = String(batch?.id);

    try {
      await generateBatchAppointments(batchId, admin);
      const appointments = await pool.query(
        "SELECT schedule_type, status, is_published FROM appointments WHERE batch_id=$1 ORDER BY schedule_type",
        [batchId],
      );
      expect(appointments.rows).toEqual([
        { schedule_type: "LABORATORY", status: "DRAFT", is_published: false },
        { schedule_type: "PHYSICAL_EXAM", status: "DRAFT", is_published: false },
      ]);
      await expect(generateBatchAppointments(batchId, admin)).rejects.toMatchObject({ code: "BATCH_IMMUTABLE" });
    } finally {
      await pool.query("DELETE FROM appointments WHERE batch_id=$1", [batchId]);
      await pool.query("DELETE FROM schedule_batches WHERE id=$1", [batchId]);
    }
  });
});
