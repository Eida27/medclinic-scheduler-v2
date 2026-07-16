// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOMATIC_NO_SHOW_NOTE,
  isAutomaticNoShowLog,
} from "@/server/appointments/automatic-no-show";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { markOverdueAppointmentsNoShow } from "./appointment-no-show.repository";

const studentPattern = "TEST-AUTO-NS-%";
const batchPattern = "TEST automatic no-show fixture%";
const timeZone = "Asia/Manila";
const dateOnlyBoundary = new Date("2045-01-11T16:00:00.000Z"); // Jan 12 00:00 Manila
const timedBoundary = new Date("2045-01-11T01:00:00.000Z"); // Jan 11 09:00 Manila

type FixtureAppointment = {
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  appointmentTime?: string | null;
  status?: "DRAFT" | "PENDING" | "COMPLETED" | "NO_SHOW" | "RESCHEDULED" | "CANCELLED";
  isPublished?: boolean;
  notes?: string;
};

type SweepSnapshot = {
  appointments: Array<{
    id: string;
    updatedBy: string | null;
    updatedAt: Date;
  }>;
  existingAutomaticLogIds: string[];
};

let sweepSnapshot: SweepSnapshot | null = null;

async function insertFixtureAppointment({
  studentNumber,
  scheduleType,
  appointmentDate,
  appointmentTime = null,
  status = "PENDING",
  isPublished = true,
  notes = `Keep ${studentNumber}`,
}: FixtureAppointment) {
  await insertTestStudent({
    studentNumber,
    firstName: "Automatic",
    lastName: "NoShow",
    yearLevel: 4,
  });

  const clinicId = scheduleType === "LABORATORY"
    ? TEST_REFERENCE_IDS.laboratoryClinic
    : TEST_REFERENCE_IDS.physicalExamClinic;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date, appointment_time,
       status, is_published, notes, created_by, updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     RETURNING id`,
    [
      clinicId,
      studentNumber,
      scheduleType,
      appointmentDate,
      appointmentTime,
      status,
      isPublished,
      notes,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return result.rows[0].id;
}

async function appointmentState(id: string) {
  return (await pool.query<{ status: string; notes: string | null }>(
    "SELECT status, notes FROM appointments WHERE id=$1",
    [id],
  )).rows[0];
}

async function captureSweepState() {
  const appointments = await pool.query<{
    id: string;
    updatedBy: string | null;
    updatedAt: Date;
  }>(
    `SELECT id, updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM appointments
      WHERE is_published=TRUE
        AND status='PENDING'
        AND schedule_type IN ('LABORATORY','PHYSICAL_EXAM')`,
  );
  const appointmentIds = appointments.rows.map((appointment) => appointment.id);
  const existingLogs = await pool.query<{ id: string }>(
    `SELECT id
       FROM appointment_status_logs
      WHERE appointment_id = ANY($1::uuid[])
        AND old_status='PENDING'
        AND new_status='NO_SHOW'
        AND notes=$2
        AND changed_by IS NULL`,
    [appointmentIds, AUTOMATIC_NO_SHOW_NOTE],
  );

  sweepSnapshot = {
    appointments: appointments.rows,
    existingAutomaticLogIds: existingLogs.rows.map((log) => log.id),
  };
}

async function restoreSweepState() {
  if (!sweepSnapshot) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const appointmentIds = sweepSnapshot.appointments.map((appointment) => appointment.id);
    const generatedLogs = await client.query<{ id: string; appointmentId: string }>(
      `SELECT id, appointment_id AS "appointmentId"
         FROM appointment_status_logs
        WHERE appointment_id = ANY($1::uuid[])
          AND old_status='PENDING'
          AND new_status='NO_SHOW'
          AND notes=$2
          AND changed_by IS NULL
          AND NOT (id = ANY($3::uuid[]))`,
      [appointmentIds, AUTOMATIC_NO_SHOW_NOTE, sweepSnapshot.existingAutomaticLogIds],
    );
    const changedAppointmentIds = new Set(
      generatedLogs.rows.map((log) => log.appointmentId),
    );
    const changedAppointments = sweepSnapshot.appointments.filter(
      (appointment) => changedAppointmentIds.has(appointment.id),
    );

    if (changedAppointments.length > 0) {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE appointments appointment
            SET status='PENDING',
                updated_by=restore.updated_by,
                updated_at=restore.updated_at
           FROM UNNEST($1::uuid[], $2::uuid[], $3::timestamptz[])
             AS restore(id, updated_by, updated_at)
          WHERE appointment.id=restore.id`,
        [
          changedAppointments.map((appointment) => appointment.id),
          changedAppointments.map((appointment) => appointment.updatedBy),
          changedAppointments.map((appointment) => appointment.updatedAt),
        ],
      );
      await client.query(
        "DELETE FROM appointment_status_logs WHERE id = ANY($1::uuid[])",
        [generatedLogs.rows.map((log) => log.id)],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    sweepSnapshot = null;
  }
}

beforeEach(async () => {
  sweepSnapshot = null;
  await cleanupTestFixtures(studentPattern, batchPattern);
});

afterEach(async () => {
  try {
    await restoreSweepState();
  } finally {
    await cleanupTestFixtures(studentPattern, batchPattern);
  }
});

afterAll(async () => {
  try {
    const leakedFixtures = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM students WHERE student_number LIKE $1",
      [studentPattern],
    );
    expect(leakedFixtures.rows[0].count).toBe(0);
  } finally {
    await pool.end();
  }
});

describe("isAutomaticNoShowLog", () => {
  it("recognizes only the canonical automatic no-show transition", () => {
    const canonicalLog = {
      oldStatus: "PENDING",
      newStatus: "NO_SHOW",
      notes: AUTOMATIC_NO_SHOW_NOTE,
      changedById: null,
    };

    expect(isAutomaticNoShowLog(canonicalLog)).toBe(true);
    expect(isAutomaticNoShowLog(null)).toBe(false);
    expect(isAutomaticNoShowLog(undefined)).toBe(false);
    expect(isAutomaticNoShowLog({ ...canonicalLog, oldStatus: "DRAFT" })).toBe(false);
    expect(isAutomaticNoShowLog({ ...canonicalLog, newStatus: "PENDING" })).toBe(false);
    expect(isAutomaticNoShowLog({ ...canonicalLog, notes: "Manual no-show" })).toBe(false);
    expect(isAutomaticNoShowLog({ ...canonicalLog, changedById: "user-id" })).toBe(false);
  });
});

describe("markOverdueAppointmentsNoShow", () => {
  it("transitions only published pending appointments at the inclusive Manila boundary", async () => {
    const dateOnlyId = await insertFixtureAppointment({
      studentNumber: "TEST-AUTO-NS-DATE",
      scheduleType: "LABORATORY",
      appointmentDate: "2045-01-10",
      notes: "Keep date-only note",
    });
    const timedId = await insertFixtureAppointment({
      studentNumber: "TEST-AUTO-NS-TIMED",
      scheduleType: "PHYSICAL_EXAM",
      appointmentDate: "2045-01-10",
      appointmentTime: "09:00:00",
      notes: "Keep timed note",
    });
    const unchangedFixtures = [
      { studentNumber: "TEST-AUTO-NS-DRAFT", status: "DRAFT", isPublished: false },
      { studentNumber: "TEST-AUTO-NS-UNPUB", status: "PENDING", isPublished: false },
      { studentNumber: "TEST-AUTO-NS-COMP", status: "COMPLETED", isPublished: true },
      { studentNumber: "TEST-AUTO-NS-CANCEL", status: "CANCELLED", isPublished: true },
      { studentNumber: "TEST-AUTO-NS-RESCHED", status: "RESCHEDULED", isPublished: true },
      { studentNumber: "TEST-AUTO-NS-NOSHOW", status: "NO_SHOW", isPublished: true },
    ] as const;
    const unchangedIds = new Map<string, string>();
    for (const fixture of unchangedFixtures) {
      unchangedIds.set(fixture.studentNumber, await insertFixtureAppointment({
        ...fixture,
        scheduleType: "LABORATORY",
        appointmentDate: "2045-01-01",
      }));
    }

    await captureSweepState();

    const beforeTimed = await markOverdueAppointmentsNoShow(
      new Date(timedBoundary.getTime() - 1),
      timeZone,
    );
    expect(beforeTimed.appointmentIds).not.toContain(timedId);
    expect(await appointmentState(timedId)).toMatchObject({ status: "PENDING" });

    expect(await markOverdueAppointmentsNoShow(timedBoundary, timeZone)).toEqual({
      count: 1,
      appointmentIds: [timedId],
    });
    expect(await appointmentState(timedId)).toEqual({
      status: "NO_SHOW",
      notes: "Keep timed note",
    });

    const beforeDateOnly = await markOverdueAppointmentsNoShow(
      new Date(dateOnlyBoundary.getTime() - 1),
      timeZone,
    );
    expect(beforeDateOnly.appointmentIds).not.toContain(dateOnlyId);
    expect(await appointmentState(dateOnlyId)).toMatchObject({ status: "PENDING" });

    expect(await markOverdueAppointmentsNoShow(dateOnlyBoundary, timeZone)).toEqual({
      count: 1,
      appointmentIds: [dateOnlyId],
    });
    expect(await appointmentState(dateOnlyId)).toEqual({
      status: "NO_SHOW",
      notes: "Keep date-only note",
    });

    for (const fixture of unchangedFixtures) {
      const state = await appointmentState(unchangedIds.get(fixture.studentNumber)!);
      expect(state).toMatchObject({
        status: fixture.status,
        notes: `Keep ${fixture.studentNumber}`,
      });
    }

    const fixtureIds = [dateOnlyId, timedId, ...unchangedIds.values()];
    const logs = await pool.query<{
      appointmentId: string;
      oldStatus: string | null;
      newStatus: string;
      notes: string | null;
      changedById: string | null;
    }>(
      `SELECT appointment_id AS "appointmentId", old_status AS "oldStatus",
              new_status AS "newStatus", notes, changed_by AS "changedById"
         FROM appointment_status_logs
        WHERE appointment_id = ANY($1::uuid[])
        ORDER BY appointment_id`,
      [fixtureIds],
    );

    expect(logs.rows).toHaveLength(2);
    expect(logs.rows.map((log) => log.appointmentId).sort()).toEqual(
      [dateOnlyId, timedId].sort(),
    );
    expect(logs.rows.every((log) => isAutomaticNoShowLog(log))).toBe(true);
  });

  it("updates and logs one eligible appointment only once across concurrent sweeps", async () => {
    const appointmentId = await insertFixtureAppointment({
      studentNumber: "TEST-AUTO-NS-RACE",
      scheduleType: "PHYSICAL_EXAM",
      appointmentDate: "2045-01-10",
      appointmentTime: "09:00:00",
      notes: "Keep race note",
    });

    await captureSweepState();
    const beforeBoundary = await markOverdueAppointmentsNoShow(
      new Date(timedBoundary.getTime() - 1),
      timeZone,
    );
    expect(beforeBoundary.appointmentIds).not.toContain(appointmentId);
    expect(await appointmentState(appointmentId)).toMatchObject({ status: "PENDING" });

    const sweeps = await Promise.all([
      markOverdueAppointmentsNoShow(timedBoundary, timeZone),
      markOverdueAppointmentsNoShow(timedBoundary, timeZone),
    ]);
    const logCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM appointment_status_logs
        WHERE appointment_id=$1`,
      [appointmentId],
    );

    expect(sweeps.reduce((sum, sweep) => sum + sweep.count, 0)).toBe(1);
    expect(sweeps.flatMap((sweep) => sweep.appointmentIds)).toEqual([appointmentId]);
    expect(logCount.rows[0].count).toBe(1);
    expect(await appointmentState(appointmentId)).toEqual({
      status: "NO_SHOW",
      notes: "Keep race note",
    });
  });
});
