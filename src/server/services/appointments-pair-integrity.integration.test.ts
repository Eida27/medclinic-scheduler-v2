// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";

const studentPattern = "TEST-PAIR-I-%";
const batchPattern = "TEST pair integrity%";
const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

type PairStatus = "PENDING" | "COMPLETED" | "NO_SHOW" | "CANCELLED";

async function createPair(input: {
  studentNumber: string;
  laboratoryStatus?: PairStatus | null;
  physicalExamStatus?: PairStatus;
}) {
  await insertTestStudent({
    studentNumber: input.studentNumber,
    firstName: "Pair",
    lastName: "Integrity",
    yearLevel: 3,
  });
  const schedulePairId = randomUUID();
  let laboratoryId: string | null = null;
  if (input.laboratoryStatus !== null) {
    const laboratory = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by
       ) VALUES ($1,$2,'LABORATORY','2045-08-18',$3,TRUE,$4,2045,$5,$5)
       RETURNING id::text`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        input.studentNumber,
        input.laboratoryStatus ?? "PENDING",
        schedulePairId,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );
    laboratoryId = laboratory.rows[0].id;
    if (input.laboratoryStatus === "COMPLETED") {
      await pool.query(
        `INSERT INTO appointment_status_logs (
           appointment_id,old_status,new_status,notes,changed_by
         ) VALUES ($1,'PENDING','COMPLETED','Fixture completion',$2)`,
        [laboratoryId, TEST_REFERENCE_IDS.adminUser],
      );
    }
  }
  const physical = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,created_by,updated_by
     ) VALUES ($1,$2,'PHYSICAL_EXAM','2045-08-20',$3,TRUE,$4,2045,$5,$5)
     RETURNING id::text`,
    [
      TEST_REFERENCE_IDS.physicalExamClinic,
      input.studentNumber,
      input.physicalExamStatus ?? "PENDING",
      schedulePairId,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return { laboratoryId, physicalExamId: physical.rows[0].id };
}

async function statuses(studentNumber: string) {
  return (await pool.query<{ schedule_type: string; status: string }>(
    `SELECT schedule_type,status FROM appointments
      WHERE student_number=$1 ORDER BY schedule_type`,
    [studentNumber],
  )).rows;
}

beforeAll(async () => {
  await cleanupTestFixtures(studentPattern, batchPattern);
});

afterAll(async () => {
  await cleanupTestFixtures(studentPattern, batchPattern);
  await pool.end();
});

describe("pair-aware appointment lifecycle", () => {
  it.each([
    ["pending", "TEST-PAIR-I-PE-P", "PENDING"],
    ["no-show", "TEST-PAIR-I-PE-N", "NO_SHOW"],
    ["cancelled", "TEST-PAIR-I-PE-C", "CANCELLED"],
    ["missing", "TEST-PAIR-I-PE-M", null],
  ] as const)("rejects quick Physical Examination completion with a %s Laboratory", async (
    _,
    studentNumber,
    laboratoryStatus,
  ) => {
    const fixture = await createPair({ studentNumber, laboratoryStatus });
    const before = await statuses(studentNumber);

    await expect(updateAppointment(fixture.physicalExamId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
    }, admin)).rejects.toMatchObject({ code: "LABORATORY_NOT_COMPLETED", status: 409 });

    await expect(statuses(studentNumber)).resolves.toEqual(before);
  });

  it("permits quick Physical Examination completion after Laboratory completion", async () => {
    const studentNumber = "TEST-PAIR-I-PE-OK";
    const fixture = await createPair({ studentNumber, laboratoryStatus: "COMPLETED" });

    await expect(updateAppointment(fixture.physicalExamId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
    }, admin)).resolves.toMatchObject({ id: fixture.physicalExamId, status: "COMPLETED" });
  });

  it("enforces the Laboratory prerequisite in detailed completion", async () => {
    const studentNumber = "TEST-PAIR-I-PE-D";
    const fixture = await createPair({ studentNumber, laboratoryStatus: "PENDING" });

    await expect(updateAppointment(fixture.physicalExamId, {
      status: "COMPLETED",
      notes: "Detailed completion attempt",
    }, admin)).rejects.toMatchObject({ code: "LABORATORY_NOT_COMPLETED", status: 409 });
  });

  it.each(["quick", "detailed"] as const)(
    "rejects %s Laboratory rollback when Physical Examination is completed",
    async (path) => {
      const studentNumber = path === "quick" ? "TEST-PAIR-I-R-Q" : "TEST-PAIR-I-R-D";
      const fixture = await createPair({
        studentNumber,
        laboratoryStatus: "COMPLETED",
        physicalExamStatus: "COMPLETED",
      });
      const request = path === "quick"
        ? { quickStatusAction: "REVERT_COMPLETION", expectedStatus: "COMPLETED" }
        : { status: "PENDING", correctionReason: "Correct fixture status", source: "LABORATORY" };

      await expect(updateAppointment(fixture.laboratoryId!, request, admin)).rejects.toMatchObject({
        code: "PHYSICAL_ALREADY_COMPLETED",
        status: 409,
      });
      await expect(statuses(studentNumber)).resolves.toEqual([
        { schedule_type: "LABORATORY", status: "COMPLETED" },
        { schedule_type: "PHYSICAL_EXAM", status: "COMPLETED" },
      ]);
    },
  );

  it.each(["PENDING", "NO_SHOW"] as const)(
    "atomically cascades Laboratory cancellation to a %s Physical Examination",
    async (physicalExamStatus) => {
      const studentNumber = physicalExamStatus === "PENDING"
        ? "TEST-PAIR-I-C-P"
        : "TEST-PAIR-I-C-N";
      const fixture = await createPair({
        studentNumber,
        laboratoryStatus: "PENDING",
        physicalExamStatus,
      });

      await updateAppointment(fixture.laboratoryId!, {
        status: "CANCELLED",
        notes: "Cancel unfinished pair",
      }, admin);

      await expect(statuses(studentNumber)).resolves.toEqual([
        { schedule_type: "LABORATORY", status: "CANCELLED" },
        { schedule_type: "PHYSICAL_EXAM", status: "CANCELLED" },
      ]);
      const sideEffects = await pool.query<{ histories: number; audits: number; notifications: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM appointment_status_logs
             WHERE appointment_id IN ($1,$2) AND new_status='CANCELLED') AS histories,
           (SELECT COUNT(*)::int FROM audit_logs
             WHERE entity_type='appointment' AND entity_id IN ($1::text,$2::text)
               AND action='APPOINTMENT_STATUS_CHANGED') AS audits,
           (SELECT COUNT(*)::int FROM student_portal_notifications
             WHERE student_number=$3 AND notification_type='SCHEDULE_CANCELLED') AS notifications`,
        [fixture.laboratoryId, fixture.physicalExamId, studentNumber],
      );
      expect(sideEffects.rows).toEqual([{ histories: 2, audits: 2, notifications: 1 }]);
    },
  );

  it("cancels only Physical Examination when requested directly", async () => {
    const studentNumber = "TEST-PAIR-I-C-PE";
    const fixture = await createPair({ studentNumber, laboratoryStatus: "PENDING" });

    await updateAppointment(fixture.physicalExamId, {
      status: "CANCELLED",
      notes: "Cancel Physical Examination only",
    }, admin);

    await expect(statuses(studentNumber)).resolves.toEqual([
      { schedule_type: "LABORATORY", status: "PENDING" },
      { schedule_type: "PHYSICAL_EXAM", status: "CANCELLED" },
    ]);
  });

  it("rejects Laboratory cancellation when Physical Examination is already completed", async () => {
    const studentNumber = "TEST-PAIR-I-C-X";
    const fixture = await createPair({
      studentNumber,
      laboratoryStatus: "PENDING",
      physicalExamStatus: "COMPLETED",
    });
    const before = await statuses(studentNumber);

    await expect(updateAppointment(fixture.laboratoryId!, {
      status: "CANCELLED",
      notes: "Attempt inconsistent cancellation",
    }, admin)).rejects.toMatchObject({ code: "PHYSICAL_ALREADY_COMPLETED", status: 409 });

    await expect(statuses(studentNumber)).resolves.toEqual(before);
  });
});
