// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool, transaction } from "@/server/db/pool";
import {
  cleanupTestFixtures,
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

async function insertAppointment(input: {
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: "PENDING" | "COMPLETED" | "NO_SHOW" | "RESCHEDULED" | "CANCELLED";
  schedulePairId?: string | null;
}) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,created_by,updated_by
     ) VALUES ($1,$2,$3,$4,$5,TRUE,$6,2045,$7,$7)
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
  return result.rows[0].id;
}

beforeAll(async () => {
  await cleanupTestFixtures(studentPattern, batchPattern);
  for (const studentNumber of ["TEST-PAIR-R-LINEAGE", "TEST-PAIR-R-FALLBK"]) {
    await insertTestStudent({
      studentNumber,
      firstName: "Pair",
      lastName: "Resolver",
      yearLevel: 3,
    });
  }

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
  await cleanupTestFixtures(studentPattern, batchPattern);
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
