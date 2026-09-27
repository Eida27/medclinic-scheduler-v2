// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import {
  cleanupTestFixtures,
  insertTestAcademicSnapshot,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { resolveEffectiveAppointmentPair } from "./effective-appointment-pair.repository";

const studentPattern = "TEST-PAIR-R-%";
const batchPattern = "TEST pair resolver%";
const preferredPairId = "71000000-0000-4000-8000-000000000001";
let preferredPhysicalId: string;
let preferredLaboratoryId: string;
let fallbackPhysicalId: string;
let fallbackLaboratoryId: string;
let createdYear = false;

async function insertAppointment(input: {
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: "PENDING" | "COMPLETED" | "NO_SHOW" | "RESCHEDULED" | "CANCELLED";
  schedulePairId?: string | null;
}) {
  return transaction(async (client) => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by
     ) VALUES ($1,$2,$3,$4,$5,TRUE,$6,2045,'REGULAR',$7,$7)
     RETURNING id::text`,
    [
      input.scheduleType === "LABORATORY"
        ? TEST_REFERENCE_IDS.laboratoryClinic
        : TEST_REFERENCE_IDS.physicalExamClinic,
      input.studentNumber,
      input.scheduleType,
      input.appointmentDate,
      input.status,
      input.schedulePairId ?? null,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  if (input.scheduleType === "LABORATORY") {
    await linkPublishedLaboratoryAppointments(client, [result.rows[0].id]);
    if (input.status === "COMPLETED") {
      await client.query(`UPDATE laboratory_checklist_items
        SET verified_at=NOW(),verified_by=$2,verification_source='INTERNAL'
        WHERE checklist_id=(SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id=$1)`,
      [result.rows[0].id, TEST_REFERENCE_IDS.adminUser]);
    }
  }
  return result.rows[0].id;
  });
}

beforeAll(async () => {
  await cleanupTestFixtures(studentPattern, batchPattern, batchPattern);
  const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
    VALUES (2045,'2046-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
  [TEST_REFERENCE_IDS.adminUser]);
  createdYear = Boolean(year.rowCount);
  for (const studentNumber of ["TEST-PAIR-R-LINEAGE", "TEST-PAIR-R-FALLBK"]) {
    await insertTestStudent({
      studentNumber,
      firstName: "Pair",
      lastName: "Resolver",
      yearLevel: 3,
    });
  }
  await transaction(async (client) => {
    for (const studentNumber of ["TEST-PAIR-R-LINEAGE", "TEST-PAIR-R-FALLBK"]) {
      await insertTestAcademicSnapshot(client, {
        studentNumber, academicYearStart: 2045,
        importName: `TEST pair resolver provenance ${studentNumber}`,
        actor: TEST_REFERENCE_IDS.adminUser,
      });
    }
  });

  preferredLaboratoryId = await insertAppointment({
    studentNumber: "TEST-PAIR-R-LINEAGE",
    scheduleType: "LABORATORY",
    appointmentDate: "2045-08-11",
    status: "COMPLETED",
    schedulePairId: preferredPairId,
  });
  preferredPhysicalId = await insertAppointment({
    studentNumber: "TEST-PAIR-R-LINEAGE",
    scheduleType: "PHYSICAL_EXAM",
    appointmentDate: "2045-08-12",
    status: "PENDING",
    schedulePairId: preferredPairId,
  });
  await insertAppointment({
    studentNumber: "TEST-PAIR-R-LINEAGE",
    scheduleType: "LABORATORY",
    appointmentDate: "2045-09-11",
    status: "COMPLETED",
    schedulePairId: "71000000-0000-4000-8000-000000000002",
  });

  fallbackLaboratoryId = await insertAppointment({
    studentNumber: "TEST-PAIR-R-FALLBK",
    scheduleType: "LABORATORY",
    appointmentDate: "2045-08-11",
    status: "COMPLETED",
  });
  await insertAppointment({
    studentNumber: "TEST-PAIR-R-FALLBK",
    scheduleType: "LABORATORY",
    appointmentDate: "2045-08-18",
    status: "RESCHEDULED",
  });
  await insertAppointment({
    studentNumber: "TEST-PAIR-R-FALLBK",
    scheduleType: "LABORATORY",
    appointmentDate: "2045-08-19",
    status: "CANCELLED",
  });
  fallbackPhysicalId = await insertAppointment({
    studentNumber: "TEST-PAIR-R-FALLBK",
    scheduleType: "PHYSICAL_EXAM",
    appointmentDate: "2045-08-20",
    status: "PENDING",
  });
});

afterAll(async () => {
  await cleanupTestFixtures(studentPattern, batchPattern, batchPattern);
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2045");
  await pool.end();
});

describe("resolveEffectiveAppointmentPair", () => {
  it("prefers the anchor's non-null pair lineage over a newer different pair", async () => {
    const resolved = await transaction((client) => resolveEffectiveAppointmentPair(client, {
      id: preferredPhysicalId,
      studentNumber: "TEST-PAIR-R-LINEAGE",
      scheduleType: "PHYSICAL_EXAM",
      schedulePairId: preferredPairId,
      scheduleCycleStart: 2045,
    }));

    expect(resolved).toMatchObject({
      laboratory: { id: preferredLaboratoryId, scheduleType: "LABORATORY", status: "COMPLETED" },
      physicalExam: { id: preferredPhysicalId, scheduleType: "PHYSICAL_EXAM", status: "PENDING" },
    });
  });

  it("falls back deterministically within the cycle and excludes cancelled or rescheduled history", async () => {
    const resolved = await transaction((client) => resolveEffectiveAppointmentPair(client, {
      id: fallbackPhysicalId,
      studentNumber: "TEST-PAIR-R-FALLBK",
      scheduleType: "PHYSICAL_EXAM",
      schedulePairId: null,
      scheduleCycleStart: 2045,
    }));

    expect(resolved).toMatchObject({
      laboratory: { id: fallbackLaboratoryId, scheduleType: "LABORATORY", status: "COMPLETED" },
      physicalExam: { id: fallbackPhysicalId, scheduleType: "PHYSICAL_EXAM", status: "PENDING" },
    });
  });
});
