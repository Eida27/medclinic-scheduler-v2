// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertNumberedTestStudents,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { addScheduleBatch, generateBatchAppointments, validateBatch } from "./coordinator-schedules.service";

const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};
const studentNumberPattern = "TEST-CS-%";
const batchNamePattern = "TEST coordinator schedules - %";

let studentNumbers: string[];
let warningBatchId: string;
let conflictBatchId: string;
let physicalWeekBatchId: string;
let laboratoryWeekBatchId: string;
let warningDate: string;
let conflictDate: string;
let weekStart: string;
let weekEnd: string;

async function reserveUnusedFixtureDates() {
  const result = await pool.query<{
    warning_date: string;
    conflict_date: string;
    week_start: string;
    week_end: string;
  }>(
    `WITH candidates AS (
       SELECT candidate::date AS base_date
         FROM generate_series(
           date_trunc('week', CURRENT_DATE + INTERVAL '20 years'),
           date_trunc('week', CURRENT_DATE + INTERVAL '120 years'),
           INTERVAL '7 days'
         ) AS candidate
        WHERE NOT EXISTS (
          SELECT 1
            FROM appointments
           WHERE status IN ('DRAFT','PENDING')
             AND appointment_date BETWEEN candidate::date AND candidate::date + 11
        )
        ORDER BY candidate
        LIMIT 1
     )
     SELECT base_date::text AS warning_date,
            (base_date + 1)::text AS conflict_date,
            (base_date + 7)::text AS week_start,
            (base_date + 11)::text AS week_end
       FROM candidates`,
  );
  if (!result.rows[0]) throw new Error("No isolated appointment dates are available for TEST fixtures.");
  return result.rows[0];
}

async function insertBatch(batchName: string, clinicId: string) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedule_batches (
       clinic_id, batch_name, college_id, program_id, submitted_by_name, description, created_by
     ) VALUES ($1,$2,$3,$4,'Integration Test','Disposable TEST fixture',$5)
     RETURNING id`,
    [
      clinicId,
      batchName,
      TEST_REFERENCE_IDS.college,
      TEST_REFERENCE_IDS.program,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return result.rows[0].id;
}

async function insertItems(
  batchId: string,
  clinicId: string,
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY",
  fixtureStudents: string[],
  target: { date: string } | { weekStart: string; weekEnd: string },
) {
  await pool.query(
    `INSERT INTO coordinator_schedule_items (
       batch_id, clinic_id, student_number, schedule_type, priority_group_id,
       target_date, target_week_start, target_week_end, remarks
     )
     SELECT $1,$2,student_number,$3,$4,$5::date,$6::date,$7::date,'Disposable TEST fixture'
       FROM UNNEST($8::varchar[]) AS fixture(student_number)`,
    [
      batchId,
      clinicId,
      scheduleType,
      TEST_REFERENCE_IDS.regularPriority,
      "date" in target ? target.date : null,
      "weekStart" in target ? target.weekStart : null,
      "weekEnd" in target ? target.weekEnd : null,
      fixtureStudents,
    ],
  );
}

beforeAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  studentNumbers = await insertNumberedTestStudents("TEST-CS-", 180);
  ({
    warning_date: warningDate,
    conflict_date: conflictDate,
    week_start: weekStart,
    week_end: weekEnd,
  } = await reserveUnusedFixtureDates());

  warningBatchId = await insertBatch(
    "TEST coordinator schedules - warning capacity",
    TEST_REFERENCE_IDS.laboratoryClinic,
  );
  conflictBatchId = await insertBatch(
    "TEST coordinator schedules - conflict capacity",
    TEST_REFERENCE_IDS.physicalExamClinic,
  );
  physicalWeekBatchId = await insertBatch(
    "TEST coordinator schedules - physical week",
    TEST_REFERENCE_IDS.physicalExamClinic,
  );
  laboratoryWeekBatchId = await insertBatch(
    "TEST coordinator schedules - laboratory week",
    TEST_REFERENCE_IDS.laboratoryClinic,
  );

  await insertItems(
    warningBatchId,
    TEST_REFERENCE_IDS.laboratoryClinic,
    "LABORATORY",
    studentNumbers.slice(0, 130),
    { date: warningDate },
  );
  await insertItems(
    conflictBatchId,
    TEST_REFERENCE_IDS.physicalExamClinic,
    "PHYSICAL_EXAM",
    studentNumbers.slice(0, 160),
    { date: conflictDate },
  );
  await insertItems(
    physicalWeekBatchId,
    TEST_REFERENCE_IDS.physicalExamClinic,
    "PHYSICAL_EXAM",
    studentNumbers.slice(160),
    { weekStart, weekEnd },
  );
  await insertItems(
    laboratoryWeekBatchId,
    TEST_REFERENCE_IDS.laboratoryClinic,
    "LABORATORY",
    studentNumbers.slice(160),
    { weekStart, weekEnd },
  );
});

afterAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  await pool.end();
});

describe("coordinator scheduling workflow", () => {
  it("reports every missing student before creating a batch", async () => {
    const batchName = "TEST missing student validation integration";

    await expect(addScheduleBatch({
      batchName,
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      submittedByName: "Test",
      description: "Must not persist",
      items: [
        {
          studentNumber: "TEST-MISSING-STUD-1",
          scheduleType: "PHYSICAL_EXAM",
          priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
          targetDate: "2026-08-03",
          targetWeekStart: null,
          targetWeekEnd: null,
          remarks: "",
        },
        {
          studentNumber: "TEST-MISSING-STUD-2",
          scheduleType: "LABORATORY",
          priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
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
        "items.0.studentNumber": ["Student number TEST-MISSING-STUD-1 is not registered."],
        "items.1.studentNumber": ["Student number TEST-MISSING-STUD-2 is not registered."],
      },
    });

    const batches = await pool.query("SELECT 1 FROM schedule_batches WHERE batch_name=$1", [batchName]);
    expect(batches.rowCount).toBe(0);
  });

  it("classifies isolated warning and conflict capacity fixtures", async () => {
    const warning = await validateBatch(warningBatchId, admin.userId);
    const conflict = await validateBatch(conflictBatchId, admin.userId);

    expect(warning.summary.warningCount).toBe(130);
    expect(warning.summary.conflictCount).toBe(0);
    expect(conflict.summary.conflictCount).toBe(160);
  });

  it("limits capacity summaries to dates and services requested by the batch", async () => {
    await generateBatchAppointments(conflictBatchId, admin, "Integration test capacity override.");
    const physicalWeek = await validateBatch(physicalWeekBatchId, admin.userId);
    const laboratoryWeek = await validateBatch(laboratoryWeekBatchId, admin.userId);

    expect(physicalWeek.summary.capacityResults).toHaveLength(5);
    expect(laboratoryWeek.summary.capacityResults).toHaveLength(5);
    expect([...physicalWeek.summary.capacityResults, ...laboratoryWeek.summary.capacityResults].every((result) => (
      result.date >= weekStart && result.date <= weekEnd
    ))).toBe(true);
  });

  it("splits BOTH into clinic-specific batches, schedule items, and draft appointments", async () => {
    const batch = await addScheduleBatch({
      batchName: "TEST coordinator schedules - split",
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      submittedByName: "Test",
      description: "Disposable integration fixture",
      items: [{
        studentNumber: studentNumbers[179],
        scheduleType: "BOTH",
        priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
        targetDate: "2026-08-03",
        targetWeekStart: null,
        targetWeekEnd: null,
        remarks: "",
      }],
    }, admin.userId);
    const batchIds = "batchIds" in batch! ? batch.batchIds : [String(batch?.id)];

    const batches = await pool.query(
      `SELECT b.id, b.batch_name, c.code AS clinic_code
         FROM schedule_batches b
         JOIN clinics c ON c.id = b.clinic_id
        WHERE b.id = ANY($1::uuid[])
        ORDER BY c.code`,
      [batchIds],
    );
    expect(batches.rows).toEqual([
      expect.objectContaining({ batch_name: "TEST coordinator schedules - split - CPU Clinic", clinic_code: "CPU_CLINIC" }),
      expect.objectContaining({ batch_name: "TEST coordinator schedules - split - KABALAKA Clinic", clinic_code: "KABALAKA_CLINIC" }),
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
  });
});
