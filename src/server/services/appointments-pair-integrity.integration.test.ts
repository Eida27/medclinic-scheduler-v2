// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import {
  cleanupTestFixtures,
  insertTestAcademicSnapshot,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";

const studentPattern = "TEST-PAIR-I-%";
const batchPattern = "TEST pair integrity%";
let createdYear = false;
const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

type PairStatus = "PENDING" | "NO_SHOW" | "CANCELLED";

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
  return transaction(async (client) => {
    await insertTestAcademicSnapshot(client, {
      studentNumber: input.studentNumber, academicYearStart: 2045,
      importName: `TEST pair integrity ${input.studentNumber}`, actor: admin.userId,
    });
    const schedulePairId = randomUUID();
    let laboratoryId: string | null = null;
    if (input.laboratoryStatus !== null) {
      const laboratory = await client.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by
       ) VALUES ($1,$2,'LABORATORY','2045-08-18',$3,TRUE,$4,2045,'REGULAR',$5,$5)
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
      await linkPublishedLaboratoryAppointments(client, [laboratoryId]);
    }
    const physical = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by
     ) VALUES ($1,$2,'PHYSICAL_EXAM','2045-08-20',$3,TRUE,$4,2045,'REGULAR',$5,$5)
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
  });
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
  const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
    VALUES (2045,'2046-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
  [admin.userId]);
  createdYear = Boolean(year.rowCount);
});

afterAll(async () => {
  await cleanupTestFixtures(studentPattern, batchPattern, batchPattern);
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2045");
  await pool.end();
});

describe("pair-aware appointment lifecycle", () => {
  it.each([
    ["pending", "TEST-PAIR-I-PE-P", "PENDING"],
    ["no-show", "TEST-PAIR-I-PE-N", "NO_SHOW"],
    ["cancelled", "TEST-PAIR-I-PE-C", "CANCELLED"],
    ["missing", "TEST-PAIR-I-PE-M", null],
  ] as const)("rejects legacy Physical Examination completion with a %s Laboratory", async (
    _,
    studentNumber,
    laboratoryStatus,
  ) => {
    const fixture = await createPair({ studentNumber, laboratoryStatus });
    const before = await statuses(studentNumber);

    await expect(updateAppointment(fixture.physicalExamId, {
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
    }, admin)).rejects.toMatchObject({ code: "CLINICAL_COMPLETION_RETIRED", status: 422 });

    await expect(statuses(studentNumber)).resolves.toEqual(before);
  });

  it("rejects detailed completion through the generic appointment route", async () => {
    const studentNumber = "TEST-PAIR-I-PE-D";
    const fixture = await createPair({ studentNumber, laboratoryStatus: "PENDING" });

    await expect(updateAppointment(fixture.physicalExamId, {
      status: "COMPLETED",
      notes: "Detailed completion attempt",
    }, admin)).rejects.toMatchObject({ code: "CLINICAL_COMPLETION_RETIRED", status: 422 });
  });

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

});
