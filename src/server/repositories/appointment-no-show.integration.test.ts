// @vitest-environment node
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transactionSeam = vi.hoisted(() => ({
  client: null as PoolClient | null,
}));

vi.mock("@/server/db/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/pool")>();

  return {
    ...actual,
    transaction: async <T>(callback: (client: PoolClient) => Promise<T>) => {
      if (transactionSeam.client) return callback(transactionSeam.client);
      return actual.transaction(callback);
    },
  };
});

import {
  AUTOMATIC_NO_SHOW_NOTE,
  LEGACY_AUTOMATIC_NO_SHOW_NOTE,
  isAutomaticNoShowLog,
} from "@/server/appointments/automatic-no-show";
import { pool, transaction } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import {
  getNextNoShowSweepAt,
  markOverdueAppointmentsNoShow,
} from "./appointment-no-show.repository";

const studentPattern = "TEST-AUTO-NS-%";
const batchPattern = "TEST automatic no-show fixture%";
const timeZone = "Asia/Manila";
const nextDayBoundary = new Date("2045-01-10T16:00:00.000Z"); // Jan 11 00:00 Manila

type FixtureAppointment = {
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status?: "DRAFT" | "PENDING" | "COMPLETED" | "NO_SHOW" | "RESCHEDULED" | "CANCELLED";
  isPublished?: boolean;
  notes?: string;
};

async function insertFixtureAppointment(
  client: PoolClient,
  {
    studentNumber,
    scheduleType,
    appointmentDate,
    status = "PENDING",
    isPublished = true,
    notes = `Keep ${studentNumber}`,
  }: FixtureAppointment,
) {
  await client.query(
    `INSERT INTO students (
       student_number, first_name, last_name, college_id, program_id, year_level
     ) VALUES ($1,'Automatic','NoShow',$2,$3,4)`,
    [
      studentNumber,
      TEST_REFERENCE_IDS.college,
      TEST_REFERENCE_IDS.program,
    ],
  );

  const clinicId = scheduleType === "LABORATORY"
    ? TEST_REFERENCE_IDS.laboratoryClinic
    : TEST_REFERENCE_IDS.physicalExamClinic;
  const result = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, notes, created_by, updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     RETURNING id`,
    [
      clinicId,
      studentNumber,
      scheduleType,
      appointmentDate,
      status,
      isPublished,
      notes,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return result.rows[0].id;
}

async function appointmentState(client: PoolClient, id: string) {
  return (await client.query<{ status: string; notes: string | null }>(
    "SELECT status, notes FROM appointments WHERE id=$1",
    [id],
  )).rows[0];
}

async function persistedAppointmentState(id: string) {
  return (await pool.query<{ status: string; notes: string | null }>(
    "SELECT status, notes FROM appointments WHERE id=$1",
    [id],
  )).rows[0];
}

async function withRollbackTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    transactionSeam.client = client;
    return await callback(client);
  } finally {
    transactionSeam.client = null;
    await client.query("ROLLBACK");
    client.release();
  }
}

beforeEach(async () => {
  transactionSeam.client = null;
  await cleanupTestFixtures(studentPattern, batchPattern);
});

afterEach(async () => {
  transactionSeam.client = null;
  await cleanupTestFixtures(studentPattern, batchPattern);
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
    expect(isAutomaticNoShowLog({
      ...canonicalLog,
      notes: LEGACY_AUTOMATIC_NO_SHOW_NOTE,
    })).toBe(true);
  });
});

describe("markOverdueAppointmentsNoShow", () => {
  it("transitions only published pending appointments at the inclusive Manila boundary", async () => {
    await withRollbackTransaction(async (client) => {
      const eligibleFixtures = [
        {
          studentNumber: "TEST-AUTO-NS-LD",
          scheduleType: "LABORATORY",
          appointmentDate: "2045-01-10",
          notes: "Keep laboratory date-only note",
        },
        {
          studentNumber: "TEST-AUTO-NS-LT",
          scheduleType: "LABORATORY",
          appointmentDate: "2045-01-10",
          notes: "Keep laboratory timed note",
        },
        {
          studentNumber: "TEST-AUTO-NS-PD",
          scheduleType: "PHYSICAL_EXAM",
          appointmentDate: "2045-01-10",
          notes: "Keep physical date-only note",
        },
        {
          studentNumber: "TEST-AUTO-NS-PT",
          scheduleType: "PHYSICAL_EXAM",
          appointmentDate: "2045-01-10",
          notes: "Keep physical timed note",
        },
      ] satisfies FixtureAppointment[];
      const eligibleIds = new Map<string, string>();
      for (const fixture of eligibleFixtures) {
        eligibleIds.set(
          fixture.studentNumber,
          await insertFixtureAppointment(client, fixture),
        );
      }
      const unchangedFixtures = [
        { studentNumber: "TEST-AUTO-NS-DRAFT", status: "DRAFT", isPublished: true },
        { studentNumber: "TEST-AUTO-NS-UNPUB", status: "PENDING", isPublished: false },
        { studentNumber: "TEST-AUTO-NS-COMP", status: "COMPLETED", isPublished: true },
        { studentNumber: "TEST-AUTO-NS-CANCEL", status: "CANCELLED", isPublished: true },
        { studentNumber: "TEST-AUTO-NS-RESCHED", status: "RESCHEDULED", isPublished: true },
        { studentNumber: "TEST-AUTO-NS-NOSHOW", status: "NO_SHOW", isPublished: true },
      ] as const;
      const unchangedIds = new Map<string, string>();
      for (const fixture of unchangedFixtures) {
        unchangedIds.set(fixture.studentNumber, await insertFixtureAppointment(client, {
          ...fixture,
          scheduleType: "LABORATORY",
          appointmentDate: "2045-01-01",
        }));
      }

      const beforeBoundary = await markOverdueAppointmentsNoShow(
        new Date(nextDayBoundary.getTime() - 1),
        timeZone,
      );
      for (const appointmentId of eligibleIds.values()) {
        expect(beforeBoundary.appointmentIds).not.toContain(appointmentId);
      }
      for (const appointmentId of eligibleIds.values()) {
        expect(await appointmentState(client, appointmentId)).toMatchObject({
          status: "PENDING",
        });
      }
      const atBoundary = await markOverdueAppointmentsNoShow(nextDayBoundary, timeZone);
      expect(atBoundary.count).toBe(eligibleFixtures.length);
      expect(atBoundary.appointmentIds.sort()).toEqual(
        [...eligibleIds.values()].sort(),
      );
      for (const fixture of eligibleFixtures) {
        expect(await appointmentState(
          client,
          eligibleIds.get(fixture.studentNumber)!,
        )).toEqual({
          status: "NO_SHOW",
          notes: fixture.notes,
        });
      }

      for (const fixture of unchangedFixtures) {
        const state = await appointmentState(client, unchangedIds.get(fixture.studentNumber)!);
        expect(state).toMatchObject({
          status: fixture.status,
          notes: `Keep ${fixture.studentNumber}`,
        });
      }

      const fixtureIds = [...eligibleIds.values(), ...unchangedIds.values()];
      const logs = await client.query<{
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

      expect(logs.rows).toHaveLength(eligibleFixtures.length);
      expect(logs.rows.map((log) => log.appointmentId).sort()).toEqual(
        [...eligibleIds.values()].sort(),
      );
      expect(logs.rows.every((log) => isAutomaticNoShowLog(log))).toBe(true);
    });

    const rolledBackFixtures = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM students WHERE student_number LIKE $1",
      [studentPattern],
    );
    expect(rolledBackFixtures.rows[0].count).toBe(0);
  });

  it("updates and logs one eligible appointment only once across concurrent sweeps", async () => {
    const appointmentDate = "2045-01-05";
    const appointmentId = await transaction((client) => insertFixtureAppointment(client, {
      studentNumber: "TEST-AUTO-NS-RACE",
      scheduleType: "PHYSICAL_EXAM",
      appointmentDate,
      notes: "Keep race note",
    }));
    const boundary = await pool.query<{ boundary: Date }>(
      `SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) AS boundary`,
      [appointmentDate, timeZone],
    );
    const concurrencyBoundary = boundary.rows[0].boundary;

    expect(await markOverdueAppointmentsNoShow(
      new Date(concurrencyBoundary.getTime() - 1),
      timeZone,
    )).toEqual({ count: 0, appointmentIds: [] });
    expect(await persistedAppointmentState(appointmentId)).toMatchObject({ status: "PENDING" });

    const sweeps = await Promise.all([
      markOverdueAppointmentsNoShow(concurrencyBoundary, timeZone),
      markOverdueAppointmentsNoShow(concurrencyBoundary, timeZone),
    ]);
    const logs = await pool.query<{
      oldStatus: string | null;
      newStatus: string;
      notes: string | null;
      changedById: string | null;
    }>(
      `SELECT old_status AS "oldStatus", new_status AS "newStatus", notes,
              changed_by AS "changedById"
         FROM appointment_status_logs
        WHERE appointment_id=$1`,
      [appointmentId],
    );

    expect(sweeps.reduce((sum, sweep) => sum + sweep.count, 0)).toBe(1);
    expect(sweeps.flatMap((sweep) => sweep.appointmentIds)).toEqual([appointmentId]);
    expect(logs.rows).toHaveLength(1);
    expect(isAutomaticNoShowLog(logs.rows[0])).toBe(true);
    expect(await persistedAppointmentState(appointmentId)).toEqual({
      status: "NO_SHOW",
      notes: "Keep race note",
    });
  });
});

describe("getNextNoShowSweepAt", () => {
  it("returns the next midnight in the configured timezone", async () => {
    await expect(getNextNoShowSweepAt(
      new Date("2026-07-10T07:59:59.000Z"),
      timeZone,
    )).resolves.toEqual(new Date("2026-07-10T16:00:00.000Z"));

    await expect(getNextNoShowSweepAt(
      new Date("2026-07-10T16:00:00.000Z"),
      timeZone,
    )).resolves.toEqual(new Date("2026-07-11T16:00:00.000Z"));
  });
});
