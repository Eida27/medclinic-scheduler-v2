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
  it("reports every missing student before creating a batch", async () => {
    const batchName = "Missing student validation integration";

    await expect(addScheduleBatch({
      batchName,
      collegeId: "10000000-0000-4000-8000-000000000003",
      programId: "20000000-0000-4000-8000-000000000003",
      submittedByName: "Test",
      description: "Must not persist",
      items: [
        {
          studentNumber: "MISSING-STUDENT-1",
          scheduleType: "PHYSICAL_EXAM",
          priorityGroupId: "30000000-0000-4000-8000-000000000004",
          targetDate: "2026-08-03",
          targetWeekStart: null,
          targetWeekEnd: null,
          remarks: "",
        },
        {
          studentNumber: "MISSING-STUDENT-2",
          scheduleType: "LABORATORY",
          priorityGroupId: "30000000-0000-4000-8000-000000000004",
          targetDate: "2026-08-04",
          targetWeekStart: null,
          targetWeekEnd: null,
          remarks: "",
        },
      ],
    }, admin.userId)).rejects.toMatchObject({
      code: "SCHEDULE_STUDENTS_NOT_FOUND",
      status: 422,
      fields: {
        "items.0.studentNumber": ["Student number MISSING-STUDENT-1 is not registered."],
        "items.1.studentNumber": ["Student number MISSING-STUDENT-2 is not registered."],
      },
    });

    const batches = await pool.query("SELECT 1 FROM schedule_batches WHERE batch_name=$1", [batchName]);
    expect(batches.rowCount).toBe(0);
  });

  it("classifies the seeded warning and conflict capacity fixtures", async () => {
    const warning = await validateBatch("50000000-0000-4000-8000-000000000130", admin.userId);
    const conflict = await validateBatch("50000000-0000-4000-8000-000000000160", admin.userId);

    expect(warning.summary.warningCount).toBe(130);
    expect(warning.summary.conflictCount).toBe(0);
    expect(conflict.summary.conflictCount).toBe(160);
  });

  it("limits capacity summaries to dates and services requested by the batch", async () => {
    const conflictBatchId = "50000000-0000-4000-8000-000000000160";
    const weekBatches = await pool.query<{ id: string; schedule_type: string }>(
      `SELECT b.id, MIN(i.schedule_type) AS schedule_type
         FROM schedule_batches b
         JOIN coordinator_schedule_items i ON i.batch_id=b.id
        WHERE i.student_number BETWEEN 'DEMO-0161' AND 'DEMO-0180'
        GROUP BY b.id
        ORDER BY schedule_type`,
    );
    const physicalWeekBatchId = weekBatches.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!.id;
    const laboratoryWeekBatchId = weekBatches.rows.find((row) => row.schedule_type === "LABORATORY")!.id;

    try {
      await generateBatchAppointments(conflictBatchId, admin, "Integration test capacity override.");
      const physicalWeek = await validateBatch(physicalWeekBatchId, admin.userId);
      const laboratoryWeek = await validateBatch(laboratoryWeekBatchId, admin.userId);

      expect(physicalWeek.summary.capacityResults).toHaveLength(5);
      expect(laboratoryWeek.summary.capacityResults).toHaveLength(5);
      expect([...physicalWeek.summary.capacityResults, ...laboratoryWeek.summary.capacityResults].every((result) => (
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

  it("splits BOTH into clinic-specific batches, schedule items, and draft appointments", async () => {
    const batch = await addScheduleBatch({
      batchName: "Automated split integration batch",
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
    const batchIds = "batchIds" in batch! ? batch.batchIds : [String(batch?.id)];

    try {
      const batches = await pool.query(
        `SELECT b.id, b.batch_name, c.code AS clinic_code
           FROM schedule_batches b
           JOIN clinics c ON c.id = b.clinic_id
          WHERE b.id = ANY($1::uuid[])
          ORDER BY c.code`,
        [batchIds],
      );
      expect(batches.rows).toEqual([
        expect.objectContaining({ batch_name: "Automated split integration batch - CPU Clinic", clinic_code: "CPU_CLINIC" }),
        expect.objectContaining({ batch_name: "Automated split integration batch - KABALAKA Clinic", clinic_code: "KABALAKA_CLINIC" }),
      ]);

      const items = await pool.query(
        `SELECT i.schedule_type, c.code AS clinic_code
           FROM coordinator_schedule_items i
           JOIN clinics c ON c.id = i.clinic_id
          WHERE i.batch_id = ANY($1::uuid[])
          ORDER BY i.schedule_type`,
        [batchIds],
      );
      expect(items.rows).toEqual([
        { schedule_type: "LABORATORY", clinic_code: "KABALAKA_CLINIC" },
        { schedule_type: "PHYSICAL_EXAM", clinic_code: "CPU_CLINIC" },
      ]);

      for (const batchId of batchIds) await generateBatchAppointments(batchId, admin);
      const appointments = await pool.query(
        `SELECT a.schedule_type, c.code AS clinic_code, a.status, a.is_published
           FROM appointments a
           JOIN clinics c ON c.id = a.clinic_id
          WHERE a.batch_id = ANY($1::uuid[])
          ORDER BY a.schedule_type`,
        [batchIds],
      );
      expect(appointments.rows).toEqual([
        { schedule_type: "LABORATORY", clinic_code: "KABALAKA_CLINIC", status: "DRAFT", is_published: false },
        { schedule_type: "PHYSICAL_EXAM", clinic_code: "CPU_CLINIC", status: "DRAFT", is_published: false },
      ]);
      await expect(generateBatchAppointments(batchIds[0], admin)).rejects.toMatchObject({ code: "BATCH_IMMUTABLE" });
    } finally {
      await pool.query("DELETE FROM appointments WHERE batch_id = ANY($1::uuid[])", [batchIds]);
      await pool.query("DELETE FROM schedule_batches WHERE id = ANY($1::uuid[])", [batchIds]);
    }
  });
});
