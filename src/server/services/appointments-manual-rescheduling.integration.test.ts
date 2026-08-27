// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";

const cycleStart = 2094;
const studentPattern = "TEST-MR-%";
const closureReasonPattern = "TEST-MR closure%";
const reservationBatchIds: string[] = [];
let originalLaboratoryCapacity = 0;
let createdAcademicYear = false;

function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function previousDate(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

type InsertPairOptions = {
  cycle?: number;
  laboratoryDate?: string;
  physicalExamDate?: string;
};

async function insertPair(studentNumber: string, options: InsertPairOptions = {}) {
  await insertTestStudent({
    studentNumber,
    firstName: "Manual",
    lastName: "Reschedule",
    yearLevel: 3,
  });
  const pairId = randomUUID();
  const appointmentCycle = options.cycle ?? cycleStart;
  const appointments = await pool.query<{
    id: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    updated_at: Date;
  }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,created_by,updated_by,
       scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
       scheduling_window_start,scheduling_window_end
     ) VALUES
       ($1,$3,'LABORATORY',$4,'PENDING',TRUE,$6,$7,$8,$8,
        'OJT','2094-08-01T01:02:03.000Z',7,'2094-09-01','2094-09-30'),
       ($2,$3,'PHYSICAL_EXAM',$5,'PENDING',TRUE,$6,$7,$8,$8,
        'OJT','2094-08-01T01:02:03.000Z',7,'2094-09-01','2094-09-30')
     RETURNING id::text,schedule_type,updated_at`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      options.laboratoryDate ?? "2094-09-13",
      options.physicalExamDate ?? "2094-09-17",
      pairId,
      appointmentCycle,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const byService = new Map(appointments.rows.map((row) => [row.schedule_type, row]));
  return {
    pairId,
    laboratory: byService.get("LABORATORY")!,
    physicalExam: byService.get("PHYSICAL_EXAM")!,
  };
}

async function insertStandaloneLaboratory(studentNumber: string, appointmentDate: string) {
  await insertTestStudent({
    studentNumber,
    firstName: "Capacity",
    lastName: "Occupant",
    yearLevel: 3,
  });
  await pool.query(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,created_by,updated_by
     ) VALUES ($1,$2,'LABORATORY',$3,'PENDING',TRUE,$4,$5,$6,$6)`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      studentNumber,
      appointmentDate,
      randomUUID(),
      cycleStart,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
}

async function insertGlobalClosure(date: string) {
  await pool.query(
    `WITH closure AS (
       INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES ($1,$1,'CLOSURE',$2,$3,gen_random_uuid())
       RETURNING id
     )
     INSERT INTO clinic_unavailable_dates (closure_group_id,blocked_date)
     SELECT id,$1 FROM closure`,
    [date, `TEST-MR closure ${date}`, TEST_REFERENCE_IDS.adminUser],
  );
}

async function insertServiceReservation(
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM",
  date: string,
) {
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO ovpsa_first_year_batches (
       schedule_cycle_start,college_id,status,created_by,updated_by
     ) VALUES ($1,$2,'DRAFT',$3,$3) RETURNING id::text`,
    [cycleStart, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.adminUser],
  );
  reservationBatchIds.push(batch.rows[0].id);
  const laboratoryDate = scheduleType === "LABORATORY" ? date : "2094-09-13";
  const physicalExamDate = scheduleType === "PHYSICAL_EXAM" ? date : "2094-09-21";
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO ovpsa_first_year_batch_revisions (
       batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by
     ) VALUES ($1,1,'DRAFT',$2,$3,$4) RETURNING id::text`,
    [batch.rows[0].id, laboratoryDate, physicalExamDate, TEST_REFERENCE_IDS.adminUser],
  );
  await pool.query(
    `INSERT INTO ovpsa_first_year_service_reservations (
       batch_id,revision_id,schedule_type,reservation_date,status,created_by
     ) VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
    [batch.rows[0].id, revision.rows[0].id, scheduleType, date, TEST_REFERENCE_IDS.adminUser],
  );
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-MR batch%", "TEST-MR import%");
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (
        SELECT id FROM clinic_closure_groups WHERE reason LIKE $1
      )`,
    [closureReasonPattern],
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE $1", [closureReasonPattern]);
  if (reservationBatchIds.length) {
    await pool.query(
      "DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id=ANY($1::uuid[])",
      [reservationBatchIds],
    );
    await pool.query(
      "UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE id=ANY($1::uuid[])",
      [reservationBatchIds],
    );
    await pool.query(
      "DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id=ANY($1::uuid[])",
      [reservationBatchIds],
    );
    await pool.query(
      "DELETE FROM ovpsa_first_year_batches WHERE id=ANY($1::uuid[])",
      [reservationBatchIds],
    );
    reservationBatchIds.length = 0;
  }
  if (originalLaboratoryCapacity) {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=$2,max_daily_capacity=$2
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
      [TEST_REFERENCE_IDS.laboratoryClinic, originalLaboratoryCapacity],
    );
  }
}

beforeAll(async () => {
  await cleanup();
  const capacity = await pool.query<{ max_daily_capacity: number }>(
    `SELECT max_daily_capacity
       FROM clinic_capacity_settings
      WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
    [TEST_REFERENCE_IDS.laboratoryClinic],
  );
  originalLaboratoryCapacity = capacity.rows[0].max_daily_capacity;
  const academicYear = await pool.query<{ start_year: number }>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,'2095-07-31',$2,$2)
     ON CONFLICT (start_year) DO NOTHING
     RETURNING start_year`,
    [cycleStart, TEST_REFERENCE_IDS.adminUser],
  );
  createdAcademicYear = academicYear.rowCount === 1;
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  if (createdAcademicYear) {
    await pool.query("DELETE FROM academic_years WHERE start_year=$1", [cycleStart]);
  }
  await pool.end();
});

describe("manual appointment rescheduling integrity", () => {
  it.each([
    ["past", previousDate(manilaToday())],
    ["today", manilaToday()],
  ])("rejects a %s Manila destination", async (label, destinationDate) => {
    const pair = await insertPair(`TEST-MR-DATE-${label.toUpperCase()}`);

    await expect(updateAppointment(pair.laboratory.id, {
      appointmentDate: destinationDate,
      notes: "Invalid historical destination",
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_DATE_IN_PAST", status: 422 });
  });

  it("rejects an invalid clinic weekday", async () => {
    const pair = await insertPair("TEST-MR-WEEKEND");
    await expect(updateAppointment(pair.laboratory.id, {
      appointmentDate: "2094-09-12",
      notes: "Weekend destination",
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_DATE_BLOCKED", status: 422 });
  });

  it("rejects a globally closed destination", async () => {
    const pair = await insertPair("TEST-MR-CLOSURE");
    await insertGlobalClosure("2094-09-14");
    await expect(updateAppointment(pair.laboratory.id, {
      appointmentDate: "2094-09-14",
      notes: "Closed destination",
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_DATE_BLOCKED", status: 409 });
  });

  it("applies an exclusive service reservation only to its service", async () => {
    const pair = await insertPair("TEST-MR-SERVICE", {
      laboratoryDate: "2094-09-10",
    });
    await insertServiceReservation("LABORATORY", "2094-09-14");

    await expect(updateAppointment(pair.physicalExam.id, {
      appointmentDate: "2094-09-14",
      notes: "Physical Examination remains available",
    }, admin)).resolves.toMatchObject({ appointmentDate: "2094-09-14" });
  });

  it("rejects a conflicting OVPSA service-exclusive reservation", async () => {
    const pair = await insertPair("TEST-MR-OVPSA");
    await insertServiceReservation("PHYSICAL_EXAM", "2094-09-20");
    await expect(updateAppointment(pair.physicalExam.id, {
      appointmentDate: "2094-09-20",
      notes: "Reserved destination",
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_DATE_BLOCKED", status: 409 });
  });

  it("rejects a destination whose configured daily capacity is consumed", async () => {
    const pair = await insertPair("TEST-MR-CAPACITY");
    await insertStandaloneLaboratory("TEST-MR-OCCUPANT", "2094-09-14");
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1,max_daily_capacity=1
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );

    await expect(updateAppointment(pair.laboratory.id, {
      appointmentDate: "2094-09-14",
      notes: "No remaining capacity",
    }, admin)).rejects.toMatchObject({ code: "DAILY_CAPACITY_EXCEEDED", status: 409 });
  });

  it.each([
    ["Laboratory on Physical Examination", "LABORATORY", "2094-09-17"],
    ["Physical Examination on Laboratory", "PHYSICAL_EXAM", "2094-09-13"],
  ] as const)("rejects %s", async (_, scheduleType, destinationDate) => {
    const pair = await insertPair(
      scheduleType === "LABORATORY" ? "TEST-MR-ORD-LAB" : "TEST-MR-ORD-PE",
    );
    const appointmentId = scheduleType === "LABORATORY"
      ? pair.laboratory.id
      : pair.physicalExam.id;
    await expect(updateAppointment(appointmentId, {
      appointmentDate: destinationDate,
      notes: "Invalid pair order",
    }, admin)).rejects.toMatchObject({ code: "PAIR_ORDER_VIOLATION", status: 409 });
  });

  it("rejects a destination after the current cycle closing date", async () => {
    const pair = await insertPair("TEST-MR-CYCLE");
    await expect(updateAppointment(pair.physicalExam.id, {
      appointmentDate: "2095-08-01",
      notes: "Later cycle destination",
    }, admin)).rejects.toMatchObject({ code: "OUTSIDE_SCHEDULING_CYCLE", status: 422 });
  });

  it("rejects a stale optional appointment version without mutation", async () => {
    const pair = await insertPair("TEST-MR-STALE");
    const expectedUpdatedAt = pair.laboratory.updated_at.toISOString();
    await pool.query(
      "UPDATE appointments SET notes='Concurrent edit' WHERE id=$1",
      [pair.laboratory.id],
    );

    await expect(updateAppointment(pair.laboratory.id, {
      appointmentDate: "2094-09-14",
      notes: "Stale replacement",
      expectedUpdatedAt,
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_STALE", status: 409 });
    const state = await pool.query(
      `SELECT status,
              (SELECT COUNT(*)::int FROM appointments replacement
                WHERE replacement.rescheduled_from=appointment.id) AS replacements
         FROM appointments appointment WHERE appointment.id=$1`,
      [pair.laboratory.id],
    );
    expect(state.rows).toEqual([{ status: "PENDING", replacements: 0 }]);
  });

  it("moves only the selected appointment and preserves history, audit, pair, cycle, and lineage", async () => {
    const pair = await insertPair("TEST-MR-VALID");
    const expectedUpdatedAt = pair.laboratory.updated_at.toISOString();
    const replacement = await updateAppointment(pair.laboratory.id, {
      appointmentDate: "2094-09-14",
      notes: "Approved manual move",
      expectedUpdatedAt,
    }, admin);

    expect(replacement).toMatchObject({
      appointmentDate: "2094-09-14",
      rescheduledFrom: pair.laboratory.id,
      status: "PENDING",
    });
    const appointments = await pool.query(
      `SELECT id::text,schedule_type,appointment_date::text,status,is_published,
              rescheduled_from::text,schedule_pair_id::text,schedule_cycle_start,
              scheduling_category,scheduling_accepted_at,scheduling_source_row_order,
              scheduling_window_start::text,scheduling_window_end::text
         FROM appointments WHERE student_number='TEST-MR-VALID'
         ORDER BY schedule_type,created_at,id`,
    );
    expect(appointments.rows).toEqual([
      expect.objectContaining({
        id: pair.laboratory.id,
        schedule_type: "LABORATORY",
        appointment_date: "2094-09-13",
        status: "RESCHEDULED",
        is_published: false,
      }),
      expect.objectContaining({
        id: replacement!.id,
        schedule_type: "LABORATORY",
        appointment_date: "2094-09-14",
        status: "PENDING",
        is_published: true,
        rescheduled_from: pair.laboratory.id,
        schedule_pair_id: pair.pairId,
        schedule_cycle_start: cycleStart,
        scheduling_category: "OJT",
        scheduling_accepted_at: new Date("2094-08-01T01:02:03.000Z"),
        scheduling_source_row_order: 7,
        scheduling_window_start: "2094-09-01",
        scheduling_window_end: "2094-09-30",
      }),
      expect.objectContaining({
        id: pair.physicalExam.id,
        schedule_type: "PHYSICAL_EXAM",
        appointment_date: "2094-09-17",
        status: "PENDING",
        is_published: true,
        rescheduled_from: null,
      }),
    ]);
    const audit = await pool.query(
      `SELECT action,metadata->>'replacementId' AS replacement_id,
              metadata->>'appointmentDate' AS appointment_date
         FROM audit_logs
        WHERE entity_type='appointment' AND entity_id=$1
          AND action='APPOINTMENT_RESCHEDULED'`,
      [pair.laboratory.id],
    );
    expect(audit.rows).toEqual([{
      action: "APPOINTMENT_RESCHEDULED",
      replacement_id: replacement!.id,
      appointment_date: "2094-09-14",
    }]);
  });

  it("allows only one simultaneous request to consume the last destination slot", async () => {
    const first = await insertPair("TEST-MR-CONCURRENT-1");
    const second = await insertPair("TEST-MR-CONCURRENT-2");
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1,max_daily_capacity=1
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );

    const results = await Promise.allSettled([
      updateAppointment(first.laboratory.id, {
        appointmentDate: "2094-09-14",
        notes: "Competing move one",
      }, admin),
      updateAppointment(second.laboratory.id, {
        appointmentDate: "2094-09-14",
        notes: "Competing move two",
      }, admin),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "DAILY_CAPACITY_EXCEEDED", status: 409 }),
      }),
    ]);
    const destination = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM appointments
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'
          AND appointment_date='2094-09-14'
          AND status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );
    expect(destination.rows[0].count).toBe(1);
  });
});
