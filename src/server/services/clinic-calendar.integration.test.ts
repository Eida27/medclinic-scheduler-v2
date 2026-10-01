// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { lockEligibleRegularPairs } from "@/server/repositories/priority-displacement.repository";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import {
  cleanupTestFixtures,
  insertTestAcademicSnapshot,
  TEST_REFERENCE_IDS,
  insertTestStudent,
} from "@/test/integration-fixtures";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import type { SessionUser } from "@/types/roles";
import {
  listClinicClosureManualCases,
  listClinicUnavailableDates,
  previewClinicCalendarChanges,
  previewOvpsaClinicClosureBatchRecovery,
  confirmOvpsaClinicClosureBatchRecovery,
  resolveClinicClosureManualCase,
  resolveClinicClosureManualCaseWithClient,
  saveClinicCalendarChanges,
} from "./clinic-calendar.service";

import { changeCapacity } from "./appointments.service";

const studentPattern = "UCAL-%";
let capacityFixture: CapacityFixtureLock | null = null;
let createdManualResolutionAcademicYear = false;
let createdHistoricalManualYear = false;
let createdCurrentManualYear = false;
const automaticCapacityBatchIds: string[] = [];
const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
};
const requestIds = {
  pair: "90000000-0000-4000-8000-000000000001",
  pairReopenOne: "90000000-0000-4000-8000-000000000002",
  pairReopenTwo: "90000000-0000-4000-8000-000000000003",
  physical: "90000000-0000-4000-8000-000000000004",
  manual: "90000000-0000-4000-8000-000000000005",
  manualResolve: "90000000-0000-4000-8000-000000000006",
  preview: "90000000-0000-4000-8000-000000000007",
  rollback: "90000000-0000-4000-8000-000000000008",
  keepBlock: "90000000-0000-4000-8000-000000000009",
  concurrency: "90000000-0000-4000-8000-000000000010",
  mixedDraft: "90000000-0000-4000-8000-000000000011",
  restorationDraftBlock: "90000000-0000-4000-8000-000000000012",
  restorationDraftReopen: "90000000-0000-4000-8000-000000000013",
  manualAll: "90000000-0000-4000-8000-000000000014",
  notificationWarning: "90000000-0000-4000-8000-000000000015",
  mixedPolicy: "90000000-0000-4000-8000-000000000016",
} as const;

async function cleanup() {
  await transaction(async (client) => {
    await client.query(
      `DELETE FROM appointment_reschedule_events
        WHERE student_number LIKE $1`,
      [studentPattern],
    );
    await client.query(
      `DELETE FROM clinic_closure_manual_cases
        WHERE student_number LIKE $1`,
      [studentPattern],
    );
    await client.query(
      `DELETE FROM audit_logs
        WHERE metadata->>'studentNumber' LIKE $1
           OR metadata->>'requestId' = ANY($2::text[])`,
      [studentPattern, Object.values(requestIds)],
    );
    await client.query("DELETE FROM clinic_calendar_requests WHERE request_id=ANY($1::uuid[])", [Object.values(requestIds)]);
  });
  await cleanupTestFixtures(studentPattern, "UCAL-LINEAGE-%", "UCAL-%");
  await transaction(async (client) => {
    await client.query(
      `DELETE FROM clinic_unavailable_dates
        WHERE closure_group_id IN (
          SELECT id FROM clinic_closure_groups WHERE reason LIKE 'TEST-UNIFIED%'
        )`,
    );
    await client.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'TEST-UNIFIED%'");
  });
  if (automaticCapacityBatchIds.length) {
    await pool.query(
      "DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id=ANY($1::uuid[])",
      [automaticCapacityBatchIds],
    );
    await pool.query(
      "UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE id=ANY($1::uuid[])",
      [automaticCapacityBatchIds],
    );
    await pool.query(
      "DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id=ANY($1::uuid[])",
      [automaticCapacityBatchIds],
    );
    await pool.query(
      "DELETE FROM ovpsa_first_year_batches WHERE id=ANY($1::uuid[])",
      [automaticCapacityBatchIds],
    );
    automaticCapacityBatchIds.length = 0;
  }
}

async function attachStandardBatchLineage(studentNumber: string) {
  const importGroup = await pool.query<{ id: string }>(
    `INSERT INTO schedule_import_groups (
       import_name,source_filename,total_rows,created_by,student_category,
       academic_year_start,accepted_at
     ) VALUES ($1,$1,1,$2,'REGULAR',2048,'2049-07-01T00:00:00.000Z')
     RETURNING id::text`,
    [`UCAL-LINEAGE-${studentNumber}`, TEST_REFERENCE_IDS.adminUser],
  );
  const batches = await pool.query<{ id: string }>(
    `INSERT INTO schedule_batches (
       clinic_id,batch_name,status,created_by,import_group_id
     ) VALUES
       ($1,$3,'PUBLISHED',$4,$5),
       ($2,$3,'PUBLISHED',$4,$5)
     RETURNING id::text`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      `UCAL-LINEAGE-${studentNumber}`,
      TEST_REFERENCE_IDS.adminUser,
      importGroup.rows[0].id,
    ],
  );
  await pool.query(
    `UPDATE appointments appointment
        SET batch_id=batch.id
       FROM schedule_batches batch
      WHERE appointment.student_number=$1
        AND batch.id=ANY($2::uuid[])
        AND batch.clinic_id=appointment.clinic_id`,
    [studentNumber, batches.rows.map((batch) => batch.id)],
  );
}

async function createPair(input: {
  studentNumber: string;
  laboratoryDate: string;
  physicalExamDate: string;
  laboratoryStatus?: string;
  physicalExamStatus?: string;
  lockPhysical?: boolean;
}) {
  await insertTestStudent({
    studentNumber: input.studentNumber,
    firstName: "Unified",
    lastName: "Calendar",
    yearLevel: 4,
  });
  const pairId = randomUUID();
  await transaction(async (client) => {
    await insertTestAcademicSnapshot(client, {
      studentNumber: input.studentNumber,
      academicYearStart: 2048,
      importName: `UCAL-SNAPSHOT-${input.studentNumber}`,
      actor: TEST_REFERENCE_IDS.adminUser,
    });
    const inserted = await client.query<{ id: string; schedule_type: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,scheduling_category,
       is_manually_locked,locked_by,locked_at,lock_reason
     ) VALUES
       ($1,$3,'LABORATORY',$4,$6,TRUE,$8,2048,'REGULAR',FALSE,NULL,NULL,NULL),
       ($2,$3,'PHYSICAL_EXAM',$5,$7,TRUE,$8,2048,'REGULAR',$9,
        CASE WHEN $9 THEN $10::uuid ELSE NULL END,
        CASE WHEN $9 THEN NOW() ELSE NULL END,
        CASE WHEN $9 THEN 'TEST-UNIFIED protected appointment' ELSE NULL END)
     RETURNING id::text,schedule_type`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      input.studentNumber,
      input.laboratoryDate,
      input.physicalExamDate,
      input.laboratoryStatus ?? "PENDING",
      input.physicalExamStatus ?? "PENDING",
      pairId,
      input.lockPhysical ?? false,
      TEST_REFERENCE_IDS.adminUser,
    ],
    );
    const laboratoryId = inserted.rows.find((row) => row.schedule_type === "LABORATORY")!.id;
    await linkPublishedLaboratoryAppointments(client, [laboratoryId]);
    if (input.laboratoryStatus === "COMPLETED") {
      await client.query(
        `UPDATE laboratory_checklist_items SET verified_at=clock_timestamp(),
           verified_by=$2,verification_source='INTERNAL'
         WHERE checklist_id=(SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id=$1)`,
        [laboratoryId, TEST_REFERENCE_IDS.adminUser],
      );
    }
  });
}

async function createAutomaticManualCase(input: {
  studentNumber: string;
  awaitingType: "LABORATORY" | "PHYSICAL_EXAM";
}) {
  await createPair({
    studentNumber: input.studentNumber,
    laboratoryDate: "2049-08-12",
    physicalExamDate: "2049-08-20",
    laboratoryStatus: input.awaitingType === "LABORATORY" ? "AWAITING_RESCHEDULE" : "PENDING",
    physicalExamStatus: input.awaitingType === "PHYSICAL_EXAM" ? "AWAITING_RESCHEDULE" : "PENDING",
  });
  const appointments = await pool.query<{
    id: string;
    schedule_pair_id: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    `SELECT id::text,schedule_pair_id::text,schedule_type
       FROM appointments WHERE student_number=$1 ORDER BY schedule_type`,
    [input.studentNumber],
  );
  const laboratory = appointments.rows.find((row) => row.schedule_type === "LABORATORY")!;
  const physicalExam = appointments.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
  const manualCase = await pool.query<{ id: string; optimistic_token: string }>(
    `INSERT INTO clinic_closure_manual_cases (
       student_number,case_source,closure_group_id,schedule_pair_id,schedule_cycle_start,
       affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
       reason_code,reason_message,policy_metadata
     ) VALUES ($1,'AUTOMATIC_DISPLACEMENT',NULL,$2,2048,$3,$4,
               'NO_VALID_REPLACEMENT_WITHIN_CYCLE',
               'No valid replacement through cycle close.','{}'::jsonb)
     RETURNING id::text,optimistic_token::text`,
    [input.studentNumber, laboratory.schedule_pair_id, laboratory.id, physicalExam.id],
  );
  return {
    id: manualCase.rows[0].id,
    optimisticToken: manualCase.rows[0].optimistic_token,
  };
}

async function insertPublishedCapacityOccupant(input: {
  studentNumber: string;
  appointmentDate: string;
  status: "DRAFT" | "PENDING" | "COMPLETED" | "NO_SHOW";
  scheduleType?: "LABORATORY" | "PHYSICAL_EXAM";
  ovpsaLineage?: {
    batchId: string;
    revisionId: string;
    reservationId: string;
  };
}) {
  await insertTestStudent({
    studentNumber: input.studentNumber,
    firstName: "Capacity",
    lastName: "Occupant",
    yearLevel: 4,
  });
  await transaction(async (client) => {
    await insertTestAcademicSnapshot(client, {
      studentNumber: input.studentNumber,
      academicYearStart: 2048,
      importName: `UCAL-SNAPSHOT-${input.studentNumber}`,
      actor: TEST_REFERENCE_IDS.adminUser,
    });
    const inserted = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,created_by,updated_by,
       ovpsa_batch_id,ovpsa_revision_id,ovpsa_service_reservation_id,scheduling_category
     ) VALUES ($1,$2,$10,$3,$4,TRUE,$5,2048,$6,$6,$7,$8,$9,'REGULAR')
     RETURNING id::text`,
    [
      input.scheduleType === "PHYSICAL_EXAM"
        ? TEST_REFERENCE_IDS.physicalExamClinic : TEST_REFERENCE_IDS.laboratoryClinic,
      input.studentNumber,
      input.appointmentDate,
      input.status,
      randomUUID(),
      TEST_REFERENCE_IDS.adminUser,
      input.ovpsaLineage?.batchId ?? null,
      input.ovpsaLineage?.revisionId ?? null,
      input.ovpsaLineage?.reservationId ?? null,
      input.scheduleType ?? "LABORATORY",
    ],
    );
    if (input.scheduleType !== "PHYSICAL_EXAM") {
      await linkPublishedLaboratoryAppointments(client, [inserted.rows[0].id]);
    }
    if (input.status === "COMPLETED") {
      await client.query(
        `UPDATE laboratory_checklist_items SET verified_at=clock_timestamp(),
           verified_by=$2,verification_source='INTERNAL'
         WHERE checklist_id=(SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id=$1)`,
        [inserted.rows[0].id, TEST_REFERENCE_IDS.adminUser],
      );
    }
  });
}

async function createReleasedOvpsaLaboratoryLineage(date: string) {
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO ovpsa_first_year_batches (
       schedule_cycle_start,college_id,status,created_by,updated_by
     ) VALUES (2048,$1,'DRAFT',$2,$2) RETURNING id::text`,
    [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.adminUser],
  );
  automaticCapacityBatchIds.push(batch.rows[0].id);
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO ovpsa_first_year_batch_revisions (
       batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by
     ) VALUES ($1,1,'DRAFT',$2,'2049-08-23',$3) RETURNING id::text`,
    [batch.rows[0].id, date, TEST_REFERENCE_IDS.adminUser],
  );
  const reservation = await pool.query<{ id: string }>(
    `INSERT INTO ovpsa_first_year_service_reservations (
       batch_id,revision_id,schedule_type,reservation_date,status,created_by
     ) VALUES ($1,$2,'LABORATORY',$3,'ACTIVE',$4) RETURNING id::text`,
    [batch.rows[0].id, revision.rows[0].id, date, TEST_REFERENCE_IDS.adminUser],
  );
  await pool.query(
    `UPDATE ovpsa_first_year_service_reservations
        SET status='RELEASED',released_at=clock_timestamp(),released_by=$2,
            release_reason='Test automatic Manual Resolution capacity semantics'
      WHERE id=$1`,
    [reservation.rows[0].id, TEST_REFERENCE_IDS.adminUser],
  );
  return {
    batchId: batch.rows[0].id,
    revisionId: revision.rows[0].id,
    reservationId: reservation.rows[0].id,
  };
}

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

async function addActiveDraftFile(studentNumber: string) {
  const appointment = await pool.query<{ id: string }>(
    `SELECT id::text FROM appointments
      WHERE student_number=$1 AND schedule_type='LABORATORY'`,
    [studentNumber],
  );
  const submission = await pool.query<{ id: string }>(
    `INSERT INTO student_result_submissions (appointment_id,student_number,result_type)
     VALUES ($1,$2,'LABORATORY') RETURNING id::text`,
    [appointment.rows[0].id, studentNumber],
  );
  const file = await pool.query<{ id: string }>(
    `INSERT INTO student_result_files (
       submission_id,storage_key,original_filename,detected_mime_type,
       extension,byte_size,checksum_sha256
     ) VALUES ($1,$2,'private-clinical-name.pdf','application/pdf','pdf',32,$3)
     RETURNING id::text`,
    [submission.rows[0].id, `unified/${studentNumber}.pdf`, "d".repeat(64)],
  );
  return file.rows[0].id;
}

async function addActiveDraftFileToAppointment(appointmentId: string, studentNumber: string) {
  const submission = await pool.query<{ id: string }>(
    `INSERT INTO student_result_submissions (appointment_id,student_number,result_type)
     SELECT id,student_number,schedule_type FROM appointments WHERE id=$1
     RETURNING id::text`,
    [appointmentId],
  );
  await pool.query(
    `INSERT INTO student_result_files (
       submission_id,storage_key,original_filename,detected_mime_type,
       extension,byte_size,checksum_sha256
     ) VALUES ($1,$2,'restoration-private.pdf','application/pdf','pdf',32,$3)`,
    [submission.rows[0].id, `unified/${studentNumber}-restoration.pdf`, "e".repeat(64)],
  );
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, cleanup);
});
beforeEach(async () => {
  const academicYear = await pool.query<{ start_year: number }>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2048,'2049-12-31',$1,$1)
     ON CONFLICT (start_year) DO NOTHING
     RETURNING start_year`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  createdManualResolutionAcademicYear = academicYear.rowCount === 1;
});
afterEach(async () => {
  if (!capacityFixture) return;
  await cleanupAndRestoreCapacitySettings(pool, capacityFixture.originalCapacities, async () => {
    await cleanup();
    if (createdManualResolutionAcademicYear) {
      await pool.query("DELETE FROM academic_years WHERE start_year=2048");
    }
    if (createdHistoricalManualYear) {
      await pool.query("DELETE FROM academic_years WHERE start_year=2024");
    }
    if (createdCurrentManualYear) {
      await pool.query("DELETE FROM academic_years WHERE start_year=2026");
    }
    createdManualResolutionAcademicYear = false;
    createdHistoricalManualYear = false;
    createdCurrentManualYear = false;
  });
});
afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, async () => {
    await cleanup();
    const residue = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM students WHERE student_number LIKE 'UCAL-%') AS students,
      (SELECT COUNT(*)::int FROM appointments WHERE student_number LIKE 'UCAL-%') AS appointments,
      (SELECT COUNT(*)::int FROM clinic_closure_manual_cases WHERE student_number LIKE 'UCAL-%') AS cases,
      (SELECT COUNT(*)::int FROM clinic_closure_groups WHERE reason LIKE 'TEST-UNIFIED%') AS groups`);
    expect(residue.rows[0]).toEqual({ students: 0, appointments: 0, cases: 0, groups: 0 });
  });
});

describe("unified clinic calendar lifecycle", () => {
  it("keeps manual resolution writes inside the caller transaction", async () => {
    const manualCase = await createAutomaticManualCase({ studentNumber: "UCAL-TX-ROLLBACK", awaitingType: "LABORATORY" });
    await expect(transaction(async (client) => {
      await resolveClinicClosureManualCaseWithClient(client, manualCase.id, {
        action: "ASSIGN_REPLACEMENT", expectedOptimisticToken: manualCase.optimisticToken,
        laboratoryDate: "2049-08-13", preservePhysicalExam: true, reason: "Transactional resolution rollback proof.",
      }, admin);
      throw new Error("rollback caller");
    })).rejects.toThrow("rollback caller");
    expect((await pool.query("SELECT status,optimistic_token::text FROM clinic_closure_manual_cases WHERE id=$1", [manualCase.id])).rows[0])
      .toEqual({ status: "OPEN", optimistic_token: manualCase.optimisticToken });
    expect((await pool.query("SELECT id FROM appointments WHERE student_number=$1 AND rescheduled_from IS NOT NULL", ["UCAL-TX-ROLLBACK"])).rowCount).toBe(0);
  });

  it("waits for an effective-scope writer before locking the case and rechecks manual protection", async () => {
    const studentNumber = "UCAL-SCOPE-RACE";
    const manualCase = await createAutomaticManualCase({ studentNumber, awaitingType: "LABORATORY" });
    const blocker = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await lockEffectiveAppointmentScopes(blocker, [{ studentNumber, scheduleType: "LABORATORY" }]);
      let settled = false;
      pending = resolveClinicClosureManualCase(manualCase.id, {
        action: "ASSIGN_REPLACEMENT", expectedOptimisticToken: manualCase.optimisticToken,
        laboratoryDate: "2049-08-13", preservePhysicalExam: true, reason: "Concurrent clinical protection proof.",
      }, admin).then((result) => ({ result }), (error: unknown) => ({ error })).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      // A clinical writer can still take row locks: resolver has not inverted scope/row order.
      await blocker.query("SELECT id FROM clinic_closure_manual_cases WHERE id=$1 FOR UPDATE NOWAIT", [manualCase.id]);
      await blocker.query(`UPDATE appointments SET is_manually_locked=TRUE,locked_by=$2,
        locked_at=NOW(),lock_reason='Concurrent fixture protection'
        WHERE student_number=$1 AND schedule_type='LABORATORY'`, [studentNumber, admin.userId]);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ error: { status: 409 } });
      expect((await pool.query("SELECT status FROM clinic_closure_manual_cases WHERE id=$1", [manualCase.id])).rows[0].status).toBe("OPEN");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await pending;
    }
  });

  it("keeps ended-cycle manual cases in an explicit read-only year view", async () => {
    const created = await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES (2024,'2025-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
      [TEST_REFERENCE_IDS.adminUser],
    );
    createdHistoricalManualYear = created.rowCount === 1;
    const studentNumber = "UCAL-HIST-MANUAL";
    await insertTestStudent({ studentNumber, firstName: "Historical", lastName: "Manual", yearLevel: 4 });
    const fixture = await transaction(async (client) => {
      await insertTestAcademicSnapshot(client, { studentNumber, academicYearStart: 2024,
        importName: "UCAL-HIST-MANUAL", actor: TEST_REFERENCE_IDS.adminUser });
      const pairId = randomUUID();
      const appointment = await client.query<{ id: string }>(
        `INSERT INTO appointments
          (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
         VALUES ($1,$2,'PHYSICAL_EXAM','2025-03-11','AWAITING_RESCHEDULE',TRUE,$3,2024,'REGULAR',$4,$4)
         RETURNING id::text`,
        [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, pairId, TEST_REFERENCE_IDS.adminUser],
      );
      const manual = await client.query<{ id: string; optimistic_token: string }>(
        `INSERT INTO clinic_closure_manual_cases
          (student_number,case_source,schedule_pair_id,schedule_cycle_start,
           affected_physical_exam_appointment_id,reason_code,reason_message,policy_metadata)
         VALUES ($1,'AUTOMATIC_DISPLACEMENT',$2,2024,$3,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE','No valid replacement remained.','{}'::jsonb)
         RETURNING id::text,optimistic_token::text`,
        [studentNumber, pairId, appointment.rows[0].id],
      );
      return manual.rows[0];
    });

    expect(await listClinicClosureManualCases({ search: studentNumber }, admin))
      .toMatchObject({ total: 0, items: [] });
    const history = await listClinicClosureManualCases({ search: studentNumber, academicYearStart: 2024 }, admin);
    expect(history).toMatchObject({ selectedYearState: "ENDED", total: 1,
      items: [{ id: fixture.id, academicYearStart: 2024 }] });
    const currentYear = await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES (2026,'2027-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
      [TEST_REFERENCE_IDS.adminUser],
    );
    createdCurrentManualYear = currentYear.rowCount === 1;
    expect(await listClinicClosureManualCases({ search: studentNumber, academicYearStart: 2026 }, admin))
      .toMatchObject({ selectedYearState: "CURRENT", total: 0, items: [] });
    for (const action of ["KEEP_CURRENT_REPLACEMENT", "ASSIGN_REPLACEMENT"] as const) {
      await expect(resolveClinicClosureManualCase(fixture.id, {
        action, expectedOptimisticToken: fixture.optimistic_token,
        ...(action === "ASSIGN_REPLACEMENT" ? { physicalExamDate: "2025-03-12" } : {}),
        reason: "An ended academic year cannot be changed.",
      }, admin)).rejects.toMatchObject({ code: "ACADEMIC_YEAR_ENDED", status: 409 });
    }
    const unchanged = await pool.query("SELECT status FROM clinic_closure_manual_cases WHERE id=$1", [fixture.id]);
    expect(unchanged.rows[0].status).toBe("OPEN");
    await pool.query(
      `UPDATE clinic_closure_manual_cases
          SET status='RESOLVED',resolved_at=NOW(),resolved_by=$2,
              resolution_action='KEEP_CURRENT_REPLACEMENT',
              resolution_details='{}'::jsonb
        WHERE id=$1`,
      [fixture.id, TEST_REFERENCE_IDS.adminUser],
    );
    const resolvedHistory = await listClinicClosureManualCases({ search: studentNumber, academicYearStart: 2024 }, admin);
    expect(resolvedHistory).toMatchObject({ total: 1, items: [{ id: fixture.id, status: "RESOLVED" }] });
  });
  it("previews grouped impact without writing", async () => {
    await createPair({
      studentNumber: "UCAL-PREVIEW",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    const preview = await previewClinicCalendarChanges({
      requestId: requestIds.preview,
      emergencyAcknowledged: false,
      changes: [
        { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED preview" },
        { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED   preview" },
      ],
    }, admin);
    expect(preview).toMatchObject({
      affectedStudentCount: 1,
      automaticRecoveryEligibleCount: 1,
      manualResolutionRequiredCount: 0,
      completePairMoveEstimate: 1,
      preservedAppointmentCount: 0,
      closureGroups: [{ startDate: "2049-08-09", endDate: "2049-08-10" }],
    });
    await expect(pool.query("SELECT 1 FROM clinic_unavailable_dates")).resolves.toMatchObject({ rowCount: 0 });
  });

  it("uses MANUAL_ALL for otherwise eligible students and marks only the affected appointment", async () => {
    await createPair({
      studentNumber: "UCAL-MANUAL-ALL",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-20",
    });

    const result = await saveClinicCalendarChanges({
      requestId: requestIds.manualAll,
      emergencyAcknowledged: false,
      recoveryMode: "MANUAL_ALL",
      changes: [{
        action: "BLOCK",
        date: "2049-08-12",
        category: "CLOSURE",
        reason: "TEST-UNIFIED manual all",
      }],
    }, admin);

    expect(result).toMatchObject({
      autoRecoveredStudentCount: 0,
      manualCaseCount: 1,
      manualReasonGroups: [{ reasonCode: "ADMIN_CHOSE_MANUAL_RECOVERY", count: 1 }],
    });
    const appointments = await pool.query<{ schedule_type: string; status: string }>(
      `SELECT schedule_type,status FROM appointments
        WHERE student_number='UCAL-MANUAL-ALL' ORDER BY schedule_type`,
    );
    expect(appointments.rows).toEqual([
      { schedule_type: "LABORATORY", status: "AWAITING_RESCHEDULE" },
      { schedule_type: "PHYSICAL_EXAM", status: "PENDING" },
    ]);
    expect(await listClinicClosureManualCases({ search: "UCAL-MANUAL-ALL" }, admin))
      .toMatchObject({ selectedYearState: null, total: 0, items: [] });
    const explicitYearCases = await listClinicClosureManualCases({
      search: "UCAL-MANUAL-ALL",
      academicYearStart: 2048,
    }, admin);
    expect(explicitYearCases).toMatchObject({ selectedYearState: "UPCOMING", total: 1 });
    const manualCase = explicitYearCases.items[0];
    expect(manualCase.caseSource).toBe("CLINIC_CLOSURE");
    await expect(resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      laboratoryDate: "2049-08-16",
      reason: "Missing explicit related-service decision.",
    }, admin)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
    await resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      laboratoryDate: "2049-08-16",
      preservePhysicalExam: true,
      reason: "The existing Physical Examination remains safely later.",
    }, admin);
    const published = await pool.query<{ schedule_type: string; appointment_date: string }>(
      `SELECT schedule_type,appointment_date::text FROM appointments
        WHERE student_number='UCAL-MANUAL-ALL' AND is_published=TRUE
        ORDER BY schedule_type`,
    );
    expect(published.rows).toEqual([
      { schedule_type: "LABORATORY", appointment_date: "2049-08-16" },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2049-08-20" },
    ]);
  });

  it("lists automatic-displacement Manual Resolution cases without closure context", async () => {
    await createPair({
      studentNumber: "UCAL-AUTO-DISPLACE",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-20",
    });
    await attachStandardBatchLineage("UCAL-AUTO-DISPLACE");
    const appointments = await pool.query<{
      id: string;
      schedule_pair_id: string;
      schedule_type: string;
    }>(
      `UPDATE appointments
          SET status='AWAITING_RESCHEDULE',scheduling_category='REGULAR',
              scheduling_accepted_at='2049-07-01T00:00:00.000Z',
              scheduling_source_row_order=42,scheduling_window_start='2049-08-01',
              scheduling_window_end='2050-03-31'
        WHERE student_number='UCAL-AUTO-DISPLACE'
      RETURNING id::text,schedule_pair_id::text,schedule_type`,
    );
    const laboratory = appointments.rows.find((row) => row.schedule_type === "LABORATORY")!;
    const physicalExam = appointments.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    const insertedCase = await pool.query<{ id: string; optimistic_token: string }>(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,case_source,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
         reason_code,reason_message,policy_metadata
       ) VALUES ('UCAL-AUTO-DISPLACE','AUTOMATIC_DISPLACEMENT',NULL,$1,2048,$2,$3,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE','No valid replacement through cycle close.',
                 '{"sourceImportGroupId":"90000000-0000-4000-8000-000000000099"}'::jsonb)
       RETURNING id::text,optimistic_token::text`,
      [laboratory.schedule_pair_id, laboratory.id, physicalExam.id],
    );

    const page = await listClinicClosureManualCases({
      search: "UCAL-AUTO-DISPLACE",
      academicYearStart: 2048,
    }, admin);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      caseSource: "AUTOMATIC_DISPLACEMENT",
      closureGroupId: null,
      groupStartDate: null,
      groupEndDate: null,
      category: null,
      closureReason: null,
      reasonCode: "NO_VALID_REPLACEMENT_WITHIN_CYCLE",
      policyMetadata: {
        sourceImportGroupId: "90000000-0000-4000-8000-000000000099",
      },
    });

    await resolveClinicClosureManualCase(insertedCase.rows[0].id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: insertedCase.rows[0].optimistic_token,
      laboratoryDate: "2049-08-16",
      physicalExamDate: "2049-08-17",
      reason: "Assigned valid same-cycle replacement dates.",
    }, admin);
    const replacements = await pool.query(
      `SELECT batch_id::text,scheduling_category,scheduling_accepted_at,
              scheduling_source_row_order,scheduling_window_start::text,
              scheduling_window_end::text,schedule_pair_id::text,schedule_cycle_start
         FROM appointments
        WHERE student_number='UCAL-AUTO-DISPLACE' AND rescheduled_from IS NOT NULL
        ORDER BY schedule_type`,
    );
    expect(replacements.rows).toEqual([
      {
        batch_id: expect.any(String),
        scheduling_category: "REGULAR",
        scheduling_accepted_at: new Date("2049-07-01T00:00:00.000Z"),
        scheduling_source_row_order: 42,
        scheduling_window_start: "2049-08-01",
        scheduling_window_end: "2050-03-31",
        schedule_pair_id: laboratory.schedule_pair_id,
        schedule_cycle_start: 2048,
      },
      {
        batch_id: expect.any(String),
        scheduling_category: "REGULAR",
        scheduling_accepted_at: new Date("2049-07-01T00:00:00.000Z"),
        scheduling_source_row_order: 42,
        scheduling_window_start: "2049-08-01",
        scheduling_window_end: "2050-03-31",
        schedule_pair_id: laboratory.schedule_pair_id,
        schedule_cycle_start: 2048,
      },
    ]);
    const laterCandidates = await transaction((client) => lockEligibleRegularPairs(client, {
      scheduleCycleStart: 2048,
      windowStart: "2049-08-01",
      windowEnd: "2050-03-31",
      limit: 1,
    }));
    expect(laterCandidates).toEqual([expect.objectContaining({
      studentNumber: "UCAL-AUTO-DISPLACE",
      schedulingCategory: "REGULAR",
      acceptedAt: new Date("2049-07-01T00:00:00.000Z"),
      sourceRowOrder: 42,
    })]);
    const resolutionAudit = await pool.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY created_at DESC LIMIT 1",
      [insertedCase.rows[0].id],
    );
    expect(resolutionAudit.rows).toEqual([{
      action: "AUTOMATIC_DISPLACEMENT_MANUAL_CASE_RESOLVED",
    }]);
    const completionNotification = await pool.query(
      `SELECT notification_type,metadata->>'sourceType' AS source_type
         FROM student_portal_notifications
        WHERE student_number='UCAL-AUTO-DISPLACE'`,
    );
    expect(completionNotification.rows).toEqual([{
      notification_type: "SCHEDULE_MANUAL_RESOLUTION_COMPLETED",
      source_type: "AUTOMATIC_DISPLACEMENT_MANUAL_CASE",
    }]);
  });

  it("assigns only the awaiting PE when its preserved completed Laboratory has protected results", async () => {
    const studentNumber = "UCAL-AUTO-PE-LAB";
    const manualCase = await createAutomaticManualCase({
      studentNumber,
      awaitingType: "PHYSICAL_EXAM",
    });
    const appointments = await transaction(async (client) => {
      await client.query(
        `UPDATE laboratory_checklist_items SET verified_at=clock_timestamp(),
           verified_by=$2,verification_source='INTERNAL'
         WHERE checklist_id IN (
           SELECT link.checklist_id FROM laboratory_checklist_appointments link
           JOIN appointments appointment ON appointment.id=link.appointment_id
           WHERE appointment.student_number=$1 AND appointment.schedule_type='LABORATORY')`,
        [studentNumber, TEST_REFERENCE_IDS.adminUser],
      );
      return client.query<{
      id: string;
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      }>(
      `UPDATE appointments
          SET status=CASE WHEN schedule_type='LABORATORY' THEN 'COMPLETED' ELSE status END
        WHERE student_number=$1
      RETURNING id::text,schedule_type`,
      [studentNumber],
      );
    });
    const laboratory = appointments.rows.find((row) => row.schedule_type === "LABORATORY")!;
    const physicalExam = appointments.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number,appointment_id,result_status,completed_at,encoded_by
       ) VALUES ($1,$2,'COMPLETED',clock_timestamp(),$3)`,
      [studentNumber, laboratory.id, TEST_REFERENCE_IDS.clinicStaffUser],
    );
    await pool.query(
      `UPDATE clinic_closure_manual_cases
          SET policy_metadata=jsonb_build_object(
            'displacementType','PHYSICAL_EXAM_ONLY',
            'affectedAppointmentIds',jsonb_build_array($2::text)
          )
        WHERE id=$1`,
      [manualCase.id, physicalExam.id],
    );

    const listed = await listClinicClosureManualCases({ search: studentNumber, academicYearStart: 2048 }, admin);
    expect(listed.items[0]).toMatchObject({
      laboratory: { id: laboratory.id, status: "COMPLETED", affected: false },
      physicalExam: { id: physicalExam.id, status: "AWAITING_RESCHEDULE", affected: true },
      currentAssignmentBlock: null,
    });
    await resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      preserveLaboratory: true,
      physicalExamDate: "2049-08-23",
      reason: "Preserve the protected completed Laboratory and replace only PE.",
    }, admin);

    const current = await pool.query<{
      id: string;
      schedule_type: string;
      appointment_date: string;
      status: string;
      is_published: boolean;
    }>(
      `SELECT id::text,schedule_type,appointment_date::text,status,is_published
         FROM appointments WHERE student_number=$1 ORDER BY created_at,id`,
      [studentNumber],
    );
    expect(current.rows).toEqual(expect.arrayContaining([
      {
        id: laboratory.id,
        schedule_type: "LABORATORY",
        appointment_date: "2049-08-12",
        status: "COMPLETED",
        is_published: true,
      },
      expect.objectContaining({
        schedule_type: "PHYSICAL_EXAM",
        appointment_date: "2049-08-23",
        status: "PENDING",
        is_published: true,
      }),
    ]));
    expect(current.rows.filter((row) => row.schedule_type === "LABORATORY")).toHaveLength(1);
  });

  it("rejects today as an automatic-displacement Manual Resolution destination", async () => {
    const manualCase = await createAutomaticManualCase({
      studentNumber: "UCAL-AUTO-TODAY",
      awaitingType: "LABORATORY",
    });

    await expect(resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      laboratoryDate: manilaToday(),
      preservePhysicalExam: true,
      reason: "Today must not be accepted as a replacement date.",
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_DATE_IN_PAST", status: 422 });
  });

  it("rejects an automatic-displacement destination after the authoritative cycle close", async () => {
    const manualCase = await createAutomaticManualCase({
      studentNumber: "UCAL-AUTO-CYCLE",
      awaitingType: "PHYSICAL_EXAM",
    });

    await expect(resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      preserveLaboratory: true,
      physicalExamDate: "2050-01-03",
      reason: "The destination must remain inside the configured cycle.",
    }, admin)).rejects.toMatchObject({ code: "OUTSIDE_SCHEDULING_CYCLE", status: 422 });
  });

  it.each(["DRAFT", "PENDING", "COMPLETED", "NO_SHOW"] as const)(
    "counts a published %s appointment against automatic Manual Resolution capacity",
    async (status) => {
      const suffix = {
        DRAFT: "DRA",
        PENDING: "PEN",
        COMPLETED: "COM",
        NO_SHOW: "NOS",
      }[status];
      const manualCase = await createAutomaticManualCase({
        studentNumber: `UCAL-AC-${suffix}`,
        awaitingType: "LABORATORY",
      });
      await insertPublishedCapacityOccupant({
        studentNumber: `UCAL-CO-${suffix}`,
        appointmentDate: "2049-08-16",
        status,
      });
      await pool.query(
        `UPDATE clinic_capacity_settings
            SET safe_daily_capacity=1,max_daily_capacity=1
          WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
        [TEST_REFERENCE_IDS.laboratoryClinic],
      );

      await expect(resolveClinicClosureManualCase(manualCase.id, {
        action: "ASSIGN_REPLACEMENT",
        expectedOptimisticToken: manualCase.optimisticToken,
        laboratoryDate: "2049-08-16",
        preservePhysicalExam: true,
        reason: `Published ${status} appointments consume clinic capacity.`,
      }, admin)).rejects.toMatchObject({ code: "DAILY_CAPACITY_EXCEEDED", status: 409 });
    },
  );

  it("excludes an external OVPSA Laboratory from automatic Manual Resolution capacity", async () => {
    const manualCase = await createAutomaticManualCase({
      studentNumber: "UCAL-AUTO-EXT-SOURCE",
      awaitingType: "LABORATORY",
    });
    const ovpsaLineage = await createReleasedOvpsaLaboratoryLineage("2049-08-16");
    await insertPublishedCapacityOccupant({
      studentNumber: "UCAL-AUTO-EXT-OVPSA",
      appointmentDate: "2049-08-16",
      status: "PENDING",
      ovpsaLineage,
    });
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1,max_daily_capacity=1
        WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );

    await expect(resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      laboratoryDate: "2049-08-16",
      preservePhysicalExam: true,
      reason: "External Mission Hospital Laboratory does not consume clinic capacity.",
    }, admin)).resolves.toMatchObject({ status: "RESOLVED" });
  });

  it("keeps emergency cases manual in a mixed-category automatic batch", async () => {
    await createPair({
      studentNumber: "UCAL-MIX-EMERGENCY",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-20",
    });
    await createPair({
      studentNumber: "UCAL-MIX-PLANNED",
      laboratoryDate: "2049-08-13",
      physicalExamDate: "2049-08-21",
    });
    const result = await saveClinicCalendarChanges({
      requestId: requestIds.mixedPolicy,
      emergencyAcknowledged: true,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [
        { action: "BLOCK", date: "2049-08-12", category: "EMERGENCY_CLOSURE", reason: "TEST-UNIFIED mixed emergency" },
        { action: "BLOCK", date: "2049-08-13", category: "MAINTENANCE", reason: "TEST-UNIFIED mixed planned" },
      ],
    }, admin);
    expect(result).toMatchObject({
      autoRecoveredStudentCount: 1,
      movedAppointmentCount: 1,
      manualCaseCount: 1,
      manualReasonGroups: [{ reasonCode: "EMERGENCY_CLOSURE", count: 1 }],
    });
  });

  it("moves a complete pair after the group end and returns an idempotent stored result", async () => {
    await createPair({
      studentNumber: "UCAL-PAIR",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    await attachStandardBatchLineage("UCAL-PAIR");
    await pool.query(
      `UPDATE appointments
          SET scheduling_category='REGULAR',
              scheduling_accepted_at='2049-07-02T00:00:00.000Z',
              scheduling_source_row_order=7,scheduling_window_start='2049-08-01',
              scheduling_window_end='2050-03-31'
        WHERE student_number='UCAL-PAIR'`,
    );
    await pool.query(
      `UPDATE students SET email='ucal.pair@example.test',email_verified_at=NOW()
        WHERE student_number='UCAL-PAIR'`,
    );
    const request = {
      requestId: requestIds.pair,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE" as const,
      changes: [
        { action: "BLOCK" as const, date: "2049-08-09", category: "CLOSURE" as const, reason: "TEST-UNIFIED pair" },
        { action: "BLOCK" as const, date: "2049-08-10", category: "CLOSURE" as const, reason: "TEST-UNIFIED pair" },
      ],
    };
    const first = await saveClinicCalendarChanges(request, admin);
    const duplicate = await saveClinicCalendarChanges(request, admin);
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({ blockedDateCount: 2, movedStudentCount: 1, movedAppointmentCount: 2 });
    const appointments = await pool.query<{ status: string; is_published: boolean; appointment_date: string; rescheduled_from: string | null }>(
      `SELECT status,is_published,appointment_date::text,rescheduled_from::text
         FROM appointments WHERE student_number='UCAL-PAIR'
        ORDER BY appointment_date,id`,
    );
    expect(appointments.rows).toEqual([
      expect.objectContaining({ status: "RESCHEDULED", is_published: false, appointment_date: "2049-08-09" }),
      expect.objectContaining({ status: "RESCHEDULED", is_published: false, appointment_date: "2049-08-10" }),
      expect.objectContaining({ status: "PENDING", is_published: true, appointment_date: "2049-08-11", rescheduled_from: expect.any(String) }),
      expect.objectContaining({ status: "PENDING", is_published: true, appointment_date: "2049-08-12", rescheduled_from: expect.any(String) }),
    ]);
    const laterCandidates = await transaction((client) => lockEligibleRegularPairs(client, {
      scheduleCycleStart: 2048,
      windowStart: "2049-08-11",
      windowEnd: "2050-03-31",
      limit: 1,
    }));
    expect(laterCandidates).toEqual([expect.objectContaining({
      studentNumber: "UCAL-PAIR",
      schedulingCategory: "REGULAR",
      acceptedAt: new Date("2049-07-02T00:00:00.000Z"),
      sourceRowOrder: 7,
    })]);
    const notifications = await pool.query<{ notification_type: string; event_key: string; source_type: string; text_body: string }>(
      `SELECT notification.notification_type,notification.event_key,
              notification.metadata->>'sourceType' AS source_type,outbox.text_body
         FROM student_portal_notifications notification
         JOIN email_outbox outbox ON outbox.portal_notification_id=notification.id
        WHERE notification.student_number='UCAL-PAIR'`,
    );
    expect(notifications.rows).toEqual([{
      notification_type: "SCHEDULE_CLOSURE_RESCHEDULED",
      event_key: expect.stringMatching(/^schedule:event:[0-9a-f-]+:UCAL-PAIR$/),
      source_type: "APPOINTMENT_RESCHEDULE_EVENT",
      text_body: expect.stringMatching(/Previous Laboratory: 2049-08-09 at KABALAKA Clinic[\s\S]*Previous Physical Examination: 2049-08-10 at CPU Clinic[\s\S]*Reason: TEST-UNIFIED pair/),
    }]);
    await expect(saveClinicCalendarChanges({
      ...request,
      changes: [request.changes[0]],
    }, admin)).rejects.toMatchObject({ code: "CLINIC_CALENDAR_REQUEST_CONFLICT", status: 409 });
  });

  it("keeps verified Laboratory in Manual Resolution when Physical Examination closes", async () => {
    await createPair({
      studentNumber: "UCAL-PHYSICAL",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
      laboratoryStatus: "COMPLETED",
    });
    const result = await saveClinicCalendarChanges({
      requestId: requestIds.physical,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED physical only" }],
    }, admin);
    expect(result).toMatchObject({ movedStudentCount: 0, movedAppointmentCount: 0, manualCaseCount: 1 });
    const laboratory = await pool.query(
      "SELECT status,is_published,appointment_date::text FROM appointments WHERE student_number='UCAL-PHYSICAL' AND schedule_type='LABORATORY'",
    );
    expect(laboratory.rows).toEqual([{ status: "COMPLETED", is_published: true, appointment_date: "2049-08-09" }]);
    const manualCase = await pool.query(
      "SELECT reason_code FROM clinic_closure_manual_cases WHERE student_number='UCAL-PHYSICAL'",
    );
    expect(manualCase.rows).toEqual([{ reason_code: "LABORATORY_PROGRESS_RECORDED" }]);
  });

  it("keeps a real closure while routing a locked pair to manual resolution", async () => {
    await createPair({
      studentNumber: "UCAL-MANUAL",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-13",
      lockPhysical: true,
    });
    const result = await saveClinicCalendarChanges({
      requestId: requestIds.manual,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "BLOCK", date: "2049-08-12", category: "CLOSURE", reason: "TEST-UNIFIED manual" }],
    }, admin);
    expect(result).toMatchObject({ blockedDateCount: 1, manualCaseCount: 1, movedAppointmentCount: 0 });
    const states = await pool.query<{ status: string }>(
      "SELECT status FROM appointments WHERE student_number='UCAL-MANUAL' ORDER BY schedule_type",
    );
    expect(states.rows).toEqual([{ status: "AWAITING_RESCHEDULE" }, { status: "PENDING" }]);
    const cases = await listClinicClosureManualCases({
      page: 1,
      pageSize: 20,
      search: "UCAL-MANUAL",
      academicYearStart: 2048,
      date: "2049-08-12",
      service: "LABORATORY",
    }, admin);
    expect(cases).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        reasonCode: "APPOINTMENT_MANUALLY_LOCKED",
        category: "CLOSURE",
        closureReason: "TEST-UNIFIED manual",
        laboratory: expect.objectContaining({ date: "2049-08-12", status: "AWAITING_RESCHEDULE" }),
        physicalExam: expect.objectContaining({ date: "2049-08-13", status: "PENDING" }),
        currentAssignmentBlock: expect.objectContaining({ code: "APPOINTMENT_MANUALLY_LOCKED" }),
      })],
    });

    const caseId = cases.items[0].id;
    await expect(resolveClinicClosureManualCase(caseId, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: cases.items[0].optimisticToken,
      laboratoryDate: "2049-08-16",
      physicalExamDate: "2049-08-17",
      reason: "Attempt while an appointment remains locked.",
    }, admin)).rejects.toMatchObject({ code: "APPOINTMENT_MANUALLY_LOCKED", status: 409 });
    await pool.query(
      "UPDATE appointments SET is_manually_locked=FALSE,locked_by=NULL,locked_at=NULL,lock_reason=NULL WHERE student_number='UCAL-MANUAL'",
    );
    await resolveClinicClosureManualCase(caseId, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: cases.items[0].optimisticToken,
      laboratoryDate: "2049-08-16",
      physicalExamDate: "2049-08-17",
      reason: "Administrator selected safe dates.",
    }, admin);
    const current = await pool.query<{ schedule_type: string; appointment_date: string; status: string }>(
      `SELECT schedule_type,appointment_date::text,status FROM appointments
        WHERE student_number='UCAL-MANUAL' AND is_published=TRUE ORDER BY schedule_type`,
    );
    expect(current.rows).toEqual([
      { schedule_type: "LABORATORY", appointment_date: "2049-08-16", status: "PENDING" },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2049-08-17", status: "PENDING" },
    ]);
    const notificationTypes = await pool.query<{ notification_type: string; source_type: string; message: string }>(
      `SELECT notification_type,metadata->>'sourceType' AS source_type,message FROM student_portal_notifications
        WHERE student_number='UCAL-MANUAL' ORDER BY created_at,id`,
    );
    expect(notificationTypes.rows).toEqual([
      {
        notification_type: "SCHEDULE_AWAITING_RESOLUTION",
        source_type: "CLINIC_CLOSURE_MANUAL_CASE",
        message: expect.stringContaining("replacement date is pending administrator resolution"),
      },
      {
        notification_type: "SCHEDULE_MANUAL_RESOLUTION_COMPLETED",
        source_type: "CLINIC_CLOSURE_MANUAL_CASE",
        message: expect.stringContaining("2049-08-16 at KABALAKA Clinic"),
      },
    ]);
  });

  it("moves safe students in a mixed closure while live draft files block manual assignment", async () => {
    await createPair({
      studentNumber: "UCAL-MIX-SAFE",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-13",
    });
    await createPair({
      studentNumber: "UCAL-MIX-DRAFT",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-13",
    });
    const fileId = await addActiveDraftFile("UCAL-MIX-DRAFT");

    const saved = await saveClinicCalendarChanges({
      requestId: requestIds.mixedDraft,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{
        action: "BLOCK",
        date: "2049-08-12",
        category: "CLOSURE",
        reason: "TEST-UNIFIED mixed draft",
      }],
    }, admin);
    expect(saved).toMatchObject({
      movedStudentCount: 1,
      movedAppointmentCount: 2,
      manualCaseCount: 1,
    });

    const page = await listClinicClosureManualCases({
      page: 1,
      pageSize: 20,
      search: "UCAL-MIX-DRAFT",
      academicYearStart: 2048,
    }, admin);
    expect(page.items[0]).toMatchObject({
      reasonCode: "DRAFT_RESULT_FILES_EXIST",
      currentAssignmentBlock: {
        code: "DRAFT_RESULT_FILES_EXIST",
        message: expect.stringContaining("Draft result files exist"),
      },
    });
    const manualCase = page.items[0];
    await expect(resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      laboratoryDate: "2049-08-16",
      physicalExamDate: "2049-08-17",
      reason: "Safe dates selected after review.",
    }, admin)).rejects.toMatchObject({ code: "DRAFT_RESULT_FILES_EXIST", status: 409 });

    await pool.query(
      "UPDATE student_result_files SET deleted_at=NOW() WHERE id=$1",
      [fileId],
    );
    const reloaded = await listClinicClosureManualCases({
      page: 1,
      pageSize: 20,
      academicYearStart: 2048,
      search: "UCAL-MIX-DRAFT",
    }, admin);
    expect(reloaded.items[0].currentAssignmentBlock).toBeNull();
    await resolveClinicClosureManualCase(manualCase.id, {
      action: "ASSIGN_REPLACEMENT",
      expectedOptimisticToken: manualCase.optimisticToken,
      laboratoryDate: "2049-08-16",
      physicalExamDate: "2049-08-17",
      reason: "Safe dates selected after draft removal.",
    }, admin);

    const current = await pool.query<{ schedule_type: string; appointment_date: string }>(
      `SELECT schedule_type,appointment_date::text
         FROM appointments
        WHERE student_number='UCAL-MIX-DRAFT' AND is_published=TRUE
        ORDER BY schedule_type`,
    );
    expect(current.rows).toEqual([
      { schedule_type: "LABORATORY", appointment_date: "2049-08-16" },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2049-08-17" },
    ]);
    const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action,metadata FROM audit_logs
        WHERE entity_type='clinic_closure_manual_case' AND entity_id=$1
        ORDER BY created_at,id`,
      [manualCase.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      "CLINIC_CLOSURE_MANUAL_CASE_CREATED",
      "CLINIC_CLOSURE_MANUAL_CASE_RESOLVED",
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain("private-clinical-name.pdf");
    expect(audits.rows[0].metadata).toMatchObject({
      reasonCode: "DRAFT_RESULT_FILES_EXIST",
      activeDraftFileCount: 1,
      submissionIds: [expect.any(String)],
    });
  });

  it("reopening changes calendar availability without restoring appointments", async () => {
    await createPair({
      studentNumber: "UCAL-RESTORE",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    const blocked = await saveClinicCalendarChanges({
      requestId: requestIds.pair,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [
        { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED restore" },
        { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED restore" },
      ],
    }, admin);
    const first = blocked.activeUnavailableDates.find((date) => date.blockedDate === "2049-08-09")!;
    const second = blocked.activeUnavailableDates.find((date) => date.blockedDate === "2049-08-10")!;
    await saveClinicCalendarChanges({
      requestId: requestIds.pairReopenOne,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "REOPEN", date: first.blockedDate, unavailableDateId: first.id, expectedUpdatedAt: first.updatedAt }],
    }, admin);
    const final = await saveClinicCalendarChanges({
      requestId: requestIds.pairReopenTwo,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "REOPEN", date: second.blockedDate, unavailableDateId: second.id, expectedUpdatedAt: second.updatedAt }],
    }, admin);
    expect(final).toMatchObject({ reopenedDateCount: 1, movedAppointmentCount: 0 });
    const current = await pool.query<{ appointment_date: string; status: string }>(
      `SELECT appointment_date::text,status FROM appointments
        WHERE student_number='UCAL-RESTORE' AND is_published=TRUE ORDER BY appointment_date`,
    );
    expect(current.rows).toEqual([
      { appointment_date: "2049-08-11", status: "PENDING" },
      { appointment_date: "2049-08-12", status: "PENDING" },
    ]);
    const notificationTypes = await pool.query<{ notification_type: string }>(
      `SELECT notification_type FROM student_portal_notifications
        WHERE student_number='UCAL-RESTORE' ORDER BY created_at,id`,
    );
    expect(notificationTypes.rows).toEqual([
      { notification_type: "SCHEDULE_CLOSURE_RESCHEDULED" },
    ]);
    await expect(pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE restored_at IS NOT NULL OR outcome='RESTORED')::int AS restored
         FROM appointment_reschedule_events WHERE student_number='UCAL-RESTORE'`,
    )).resolves.toMatchObject({ rows: [{ total: 1, restored: 0 }] });
  });

  it("commits scheduling and audits a warning when email enqueue fails", async () => {
    await createPair({
      studentNumber: "UCAL-WARN",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    await pool.query(
      `UPDATE students SET email=$2,email_verified_at=clock_timestamp()
        WHERE student_number=$1`,
      ["UCAL-WARN", "ucal-warning@example.test"],
    );
    await pool.query(
      `CREATE OR REPLACE FUNCTION test_clinic_closure_email_enqueue_failure()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.student_number='UCAL-WARN' THEN
           RAISE EXCEPTION 'TEST clinic closure email enqueue failure';
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER test_clinic_closure_email_enqueue_failure_trigger
         BEFORE INSERT ON email_outbox FOR EACH ROW
         EXECUTE FUNCTION test_clinic_closure_email_enqueue_failure()`,
    );
    try {
      const result = await saveClinicCalendarChanges({
        requestId: requestIds.notificationWarning,
        emergencyAcknowledged: false,
        recoveryMode: "AUTO_ELIGIBLE",
        changes: [{
          action: "BLOCK",
          date: "2049-08-09",
          category: "CLOSURE",
          reason: "TEST-UNIFIED notification warning",
        }],
      }, admin);
      expect(result).toMatchObject({
        movedStudentCount: 1,
        notificationWarningCount: 1,
      });
      await expect(pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM appointments
             WHERE student_number='UCAL-WARN' AND status='PENDING' AND is_published=TRUE) AS pending,
           (SELECT COUNT(*)::int FROM student_portal_notifications
             WHERE student_number='UCAL-WARN') AS portal,
           (SELECT COUNT(*)::int FROM email_outbox
             WHERE student_number='UCAL-WARN') AS email,
           (SELECT COUNT(*)::int FROM audit_logs
             WHERE action='CLINIC_CLOSURE_NOTIFICATION_WARNING'
               AND metadata->>'studentNumber'='UCAL-WARN') AS warnings`,
      )).resolves.toMatchObject({
        rows: [{ pending: 2, portal: 1, email: 0, warnings: 1 }],
      });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_clinic_closure_email_enqueue_failure_trigger ON email_outbox");
      await pool.query("DROP FUNCTION IF EXISTS test_clinic_closure_email_enqueue_failure()");
    }
  });

  it("reopening leaves replacements and manual-case state untouched", async () => {
    await createPair({
      studentNumber: "UCAL-RESTORE-DRAFT",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    const blocked = await saveClinicCalendarChanges({
      requestId: requestIds.restorationDraftBlock,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [
        { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED restoration draft" },
        { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED restoration draft" },
      ],
    }, admin);
    const replacement = await pool.query<{ id: string }>(
      `SELECT id::text FROM appointments
        WHERE student_number='UCAL-RESTORE-DRAFT'
          AND schedule_type='LABORATORY' AND is_published=TRUE`,
    );
    await addActiveDraftFileToAppointment(replacement.rows[0].id, "UCAL-RESTORE-DRAFT");

    const unavailable = blocked.activeUnavailableDates.filter((date) =>
      date.blockedDate === "2049-08-09" || date.blockedDate === "2049-08-10");
    const reopened = await saveClinicCalendarChanges({
      requestId: requestIds.restorationDraftReopen,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: unavailable.map((date) => ({
        action: "REOPEN" as const,
        date: date.blockedDate,
        unavailableDateId: date.id,
        expectedUpdatedAt: date.updatedAt,
      })),
    }, admin);
    expect(reopened).toMatchObject({ reopenedDateCount: 2, movedAppointmentCount: 0, manualCaseCount: 0 });

    const cases = await listClinicClosureManualCases({
      page: 1,
      pageSize: 20,
      search: "UCAL-RESTORE-DRAFT",
      academicYearStart: 2048,
    }, admin);
    expect(cases).toMatchObject({ total: 0, items: [] });
    const published = await pool.query<{ status: string; count: number }>(
      `SELECT status,COUNT(*)::int AS count FROM appointments
        WHERE student_number='UCAL-RESTORE-DRAFT' AND is_published=TRUE
        GROUP BY status`,
    );
    expect(published.rows).toEqual([{ status: "PENDING", count: 2 }]);
  });

  it("allows clinic staff to read but not mutate the unified calendar", async () => {
    const staff: SessionUser = {
      userId: TEST_REFERENCE_IDS.clinicStaffUser,
      fullName: "Clinic Staff",
      email: "staff@medclinic.local",
      role: "CLINIC_STAFF",
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
    };
    await expect(listClinicUnavailableDates(staff)).resolves.toEqual([]);
    await expect(saveClinicCalendarChanges({
      requestId: randomUUID(),
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED forbidden" }],
    }, staff)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("does not retain compatibility for clinicId or UNBLOCK", async () => {
    await expect(saveClinicCalendarChanges({
      requestId: randomUUID(),
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        date: "2049-08-09",
        category: "CLOSURE",
        reason: "TEST-UNIFIED legacy clinic scope",
      }],
    }, admin)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
    await expect(saveClinicCalendarChanges({
      requestId: randomUUID(),
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{
        action: "UNBLOCK",
        date: "2049-08-09",
        unavailableDateId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
      }],
    }, admin)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
  });

  it("serializes calendar saves with imports under the shared advisory lock", async () => {
    await createPair({
      studentNumber: "UCAL-LOCK",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-13",
    });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      let settled = false;
      const pending = saveClinicCalendarChanges({
        requestId: requestIds.concurrency,
        emergencyAcknowledged: false,
        recoveryMode: "AUTO_ELIGIBLE",
        changes: [{ action: "BLOCK", date: "2049-08-12", category: "CLOSURE", reason: "TEST-UNIFIED shared lock" }],
      }, admin).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await expect(pool.query(
        "SELECT 1 FROM clinic_closure_groups WHERE reason='TEST-UNIFIED shared lock'",
      )).resolves.toMatchObject({ rowCount: 0 });
      await blocker.query("COMMIT");
      await pending;
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("rolls back the whole operation for an unexpected database failure", async () => {
    await createPair({
      studentNumber: "UCAL-GOOD",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-13",
    });
    await createPair({
      studentNumber: "UCAL-ROLL",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-13",
    });
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_unified_unexpected_failure()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.student_number='UCAL-ROLL' AND NEW.status='RESCHEDULED' THEN
          RAISE EXCEPTION 'TEST unexpected unified failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_unified_unexpected_failure
        BEFORE UPDATE ON appointments
        FOR EACH ROW EXECUTE FUNCTION test_unified_unexpected_failure();
    `);
    try {
      await expect(saveClinicCalendarChanges({
        requestId: requestIds.rollback,
        emergencyAcknowledged: false,
        recoveryMode: "AUTO_ELIGIBLE",
        changes: [{ action: "BLOCK", date: "2049-08-12", category: "CLOSURE", reason: "TEST-UNIFIED rollback" }],
      }, admin)).rejects.toThrow(/TEST unexpected unified failure/);
      await expect(pool.query(
        "SELECT 1 FROM clinic_closure_groups WHERE reason='TEST-UNIFIED rollback'",
      )).resolves.toMatchObject({ rowCount: 0 });
      const states = await pool.query<{ status: string; count: number }>(
        `SELECT status,COUNT(*)::int AS count FROM appointments
          WHERE student_number IN ('UCAL-GOOD','UCAL-ROLL') GROUP BY status`,
      );
      expect(states.rows).toEqual([{ status: "PENDING", count: 4 }]);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS test_unified_unexpected_failure ON appointments");
      await pool.query("DROP FUNCTION IF EXISTS test_unified_unexpected_failure()");
    }
  });

  it("keeps an existing safe replacement with a required audited reason", async () => {
    await createPair({
      studentNumber: "UCAL-KEEP",
      laboratoryDate: "2049-08-12",
      physicalExamDate: "2049-08-13",
    });
    await saveClinicCalendarChanges({
      requestId: requestIds.keepBlock,
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "BLOCK", date: "2049-08-12", category: "CLOSURE", reason: "TEST-UNIFIED keep" }],
    }, admin);
    const event = await pool.query<{
      id: string;
      closure_group_id: string;
      schedule_pair_id: string;
      schedule_cycle_start: number;
      old_laboratory_appointment_id: string;
      old_physical_exam_appointment_id: string;
    }>(
      `SELECT id::text,closure_group_id::text,schedule_pair_id::text,schedule_cycle_start,
              old_laboratory_appointment_id::text,old_physical_exam_appointment_id::text
         FROM appointment_reschedule_events WHERE student_number='UCAL-KEEP'`,
    );
    const manualCase = await pool.query<{ id: string; optimistic_token: string }>(
      `INSERT INTO clinic_closure_manual_cases (
         student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
         affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
         reason_code,reason_message
       ) VALUES ('UCAL-KEEP',$1,$2,$3,$4,$5,'UNSAFE_RESTORATION',
                 'TEST-UNIFIED replacement review')
       RETURNING id::text,optimistic_token::text`,
      [
        event.rows[0].closure_group_id,
        event.rows[0].schedule_pair_id,
        event.rows[0].schedule_cycle_start,
        event.rows[0].old_laboratory_appointment_id,
        event.rows[0].old_physical_exam_appointment_id,
      ],
    );
    await pool.query(
      "UPDATE appointment_reschedule_events SET manual_case_id=$2 WHERE id=$1",
      [event.rows[0].id, manualCase.rows[0].id],
    );

    await resolveClinicClosureManualCase(manualCase.rows[0].id, {
      action: "KEEP_CURRENT_REPLACEMENT",
      expectedOptimisticToken: manualCase.rows[0].optimistic_token,
      reason: "The current replacement remains safe and was accepted.",
    }, admin);
    const resolved = await pool.query<{ status: string; resolution_action: string }>(
      "SELECT status,resolution_action FROM clinic_closure_manual_cases WHERE id=$1",
      [manualCase.rows[0].id],
    );
    expect(resolved.rows).toEqual([{ status: "RESOLVED", resolution_action: "KEEP_CURRENT_REPLACEMENT" }]);
    const audit = await pool.query(
      `SELECT 1 FROM audit_logs
        WHERE entity_type='clinic_closure_manual_case' AND entity_id=$1
          AND metadata->>'resolutionAction'='KEEP_CURRENT_REPLACEMENT'`,
      [manualCase.rows[0].id],
    );
    expect(audit.rowCount).toBe(1);
  });
});


describe("closure same-cycle integrity", () => {
  it.each(["2049-07-30", "2049-08-11"])(
    "keeps no complete pair within closing %s in Manual Resolution", async (closing) => {
      await createPair({ studentNumber: "UCAL-BOUND", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-10" });
      await pool.query("UPDATE academic_years SET closing_date=$1 WHERE start_year=2048", [closing]);
      const request = { requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "AUTO_ELIGIBLE", changes: [
        { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED bound" },
        { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED bound" },
      ] };
      const preview = await previewClinicCalendarChanges({ requestId: request.requestId, emergencyAcknowledged: false, changes: request.changes }, admin);
      expect(preview).toMatchObject({ automaticRecoveryEligibleCount: 0, manualResolutionRequiredCount: 1,
        manualReasonGroups: [expect.objectContaining({ reasonCode: "NO_VALID_REPLACEMENT_WITHIN_CYCLE" })] });
      const saved = await saveClinicCalendarChanges(request, admin);
      expect(saved).toMatchObject({ movedStudentCount: 0, manualCaseCount: 1, capacityFallbackCount: 1 });
      expect((await pool.query("SELECT status FROM appointments WHERE student_number='UCAL-BOUND'")).rows)
        .toEqual([{ status: "AWAITING_RESCHEDULE" }, { status: "AWAITING_RESCHEDULE" }]);
    },
  );
  it("revalidates a shortened academic cycle at confirmation", async () => {
    await createPair({ studentNumber: "UCAL-BOUND", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-10" });
    const request = { requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "AUTO_ELIGIBLE", changes: [
      { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED bound" },
      { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED bound" },
    ] };
    expect((await previewClinicCalendarChanges({ requestId: request.requestId, emergencyAcknowledged: false, changes: request.changes }, admin)).automaticRecoveryEligibleCount).toBe(1);
    await pool.query("UPDATE academic_years SET closing_date='2049-08-11' WHERE start_year=2048");
    expect(await saveClinicCalendarChanges(request, admin)).toMatchObject({ movedStudentCount: 0, manualCaseCount: 1 });
  });
  it("reuses the retired PE slot for the next student while preserving its unblocked Laboratory", async () => {
    await createPair({ studentNumber: "UCAL-REUSE-A", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-11" });
    await createPair({ studentNumber: "UCAL-REUSE-B", laboratoryDate: "2049-08-08", physicalExamDate: "2049-08-10" });
    await pool.query("UPDATE appointments SET created_at='2049-07-01' WHERE student_number='UCAL-REUSE-A'");
    await pool.query("UPDATE appointments SET created_at='2049-07-02' WHERE student_number='UCAL-REUSE-B'");
    await pool.query("UPDATE clinic_capacity_settings SET max_daily_capacity=1,safe_daily_capacity=1");
    const request = { requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "AUTO_ELIGIBLE", changes: [
      { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED reuse" },
      { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED reuse" },
    ] };
    // A must move its PE because replacement Laboratory falls on its old PE date.
    // B preserves its unblocked Laboratory and reuses the legitimately freed PE date.
    expect(await saveClinicCalendarChanges(request, admin)).toMatchObject({ movedStudentCount: 2, movedAppointmentCount: 3 });
    expect((await pool.query("SELECT schedule_type,appointment_date::text FROM appointments WHERE student_number='UCAL-REUSE-A' AND is_published ORDER BY schedule_type")).rows)
      .toEqual([{ schedule_type: "LABORATORY", appointment_date: "2049-08-11" }, { schedule_type: "PHYSICAL_EXAM", appointment_date: "2049-08-12" }]);
    expect((await pool.query("SELECT appointment_date::text FROM appointments WHERE student_number='UCAL-REUSE-B' AND schedule_type='PHYSICAL_EXAM' AND is_published")).rows)
      .toEqual([{ appointment_date: "2049-08-11" }]);
  });
  it("rejects ordinary manual recovery beyond its configured cycle", async () => {
    await createPair({ studentNumber: "UCAL-BOUND", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-10" });
    await saveClinicCalendarChanges({ requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "MANUAL_ALL", changes: [
      { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED manual bound" },
      { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED manual bound" },
    ] }, admin);
    await pool.query("UPDATE academic_years SET closing_date='2049-08-11' WHERE start_year=2048");
    const row = (await pool.query("SELECT id,optimistic_token FROM clinic_closure_manual_cases WHERE student_number='UCAL-BOUND'")).rows[0];
    await expect(resolveClinicClosureManualCase(row.id, { action: "ASSIGN_REPLACEMENT", expectedOptimisticToken: row.optimistic_token,
      laboratoryDate: "2049-08-11", physicalExamDate: "2049-08-12", reason: "Reviewed replacement dates" }, admin))
      .rejects.toMatchObject({ code: "OUTSIDE_SCHEDULING_CYCLE" });
    expect((await pool.query("SELECT status FROM clinic_closure_manual_cases WHERE id=$1", [row.id])).rows[0].status).toBe("OPEN");
  });
});


async function ovpsaClosureFixture(closeLaboratory = true, completed = false) {
  const lineage = await createReleasedOvpsaLaboratoryLineage("2049-08-16");
  await pool.query(`UPDATE ovpsa_first_year_batch_revisions SET status='PUBLISHED',validated_by=$2,validated_at=NOW(),
    validation_snapshot='{}',published_by=$2,published_at=NOW() WHERE id=$1`, [lineage.revisionId, admin.userId]);
  await pool.query(`UPDATE ovpsa_first_year_batches SET status='PUBLISHED',current_revision_id=$2,
    published_by=$3,published_at=NOW() WHERE id=$1`, [lineage.batchId, lineage.revisionId, admin.userId]);
  await createPair({ studentNumber: "UCAL-OVPSA-BOUND", laboratoryDate: "2049-08-16", physicalExamDate: "2049-08-23" });
  const peReservation = (await pool.query(`INSERT INTO ovpsa_first_year_service_reservations
    (batch_id,revision_id,schedule_type,reservation_date,status,created_by)
    VALUES($1,$2,'PHYSICAL_EXAM','2049-08-23','ACTIVE',$3) RETURNING id`, [lineage.batchId, lineage.revisionId, admin.userId])).rows[0].id;
  await pool.query(`UPDATE appointments SET ovpsa_batch_id=$1,ovpsa_revision_id=$2,
    ovpsa_service_reservation_id=CASE schedule_type WHEN 'LABORATORY' THEN $3::uuid ELSE $4::uuid END
    WHERE student_number='UCAL-OVPSA-BOUND'`, [lineage.batchId, lineage.revisionId, lineage.reservationId, peReservation]);
  if (completed) {
    await pool.query(
      `UPDATE ovpsa_first_year_service_reservations
          SET status='ACTIVE',released_at=NULL,released_by=NULL,release_reason=NULL
        WHERE id=$1`,
      [lineage.reservationId],
    );
    await transaction(async (client) => {
      await client.query(
        `UPDATE laboratory_checklist_items SET verified_at=clock_timestamp(),
           verified_by=$1,verification_source='INTERNAL'
         WHERE checklist_id IN (
           SELECT link.checklist_id FROM laboratory_checklist_appointments link
           JOIN appointments appointment ON appointment.id=link.appointment_id
           WHERE appointment.student_number='UCAL-OVPSA-BOUND'
             AND appointment.schedule_type='LABORATORY')`,
        [TEST_REFERENCE_IDS.adminUser],
      );
      await client.query(
        "UPDATE appointments SET status='COMPLETED' WHERE student_number='UCAL-OVPSA-BOUND' AND schedule_type='LABORATORY'",
      );
    });
  }
  await saveClinicCalendarChanges({ requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "MANUAL_ALL", changes: [
    { action: "BLOCK", date: closeLaboratory ? "2049-08-16" : "2049-08-23", category: "CLOSURE", reason: "TEST-UNIFIED ovpsa bound" },
  ] }, admin);
  const batch = (await pool.query("SELECT optimistic_token FROM ovpsa_first_year_batches WHERE id=$1", [lineage.batchId])).rows[0];
  const manual = (await pool.query("SELECT id,optimistic_token FROM clinic_closure_manual_cases WHERE student_number='UCAL-OVPSA-BOUND'")).rows[0];
  return { ...lineage, optimisticToken: batch.optimistic_token as string, manual };
}

describe("OVPSA closure cycle boundaries", () => {
  it("rejects a seven-day gap crossing cycle close and preserves the open batch case", async () => {
    const fixture = await ovpsaClosureFixture();
    await pool.query("UPDATE academic_years SET closing_date='2049-08-24' WHERE start_year=2048");
    const request = { optimisticToken: fixture.optimisticToken, replacementLaboratoryDate: "2049-08-20" };
    await expect(previewOvpsaClinicClosureBatchRecovery(fixture.batchId, request, admin))
      .rejects.toMatchObject({ code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE", status: 409 });
    await expect(confirmOvpsaClinicClosureBatchRecovery(fixture.batchId, { ...request,
      caseTokens: [{ caseId: fixture.manual.id, expectedOptimisticToken: fixture.manual.optimistic_token }], reason: "Review batch dates" }, admin))
      .rejects.toMatchObject({ code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE", status: 409 });
    expect((await pool.query("SELECT status FROM clinic_closure_manual_cases WHERE id=$1", [fixture.manual.id])).rows[0].status).toBe("OPEN");
    expect((await pool.query("SELECT id FROM ovpsa_first_year_batch_revisions WHERE batch_id=$1", [fixture.batchId])).rows).toEqual([{ id: fixture.revisionId }]);
  });
  it("previews and confirms a complete batch pair on the custom last weekday", async () => {
    const fixture = await ovpsaClosureFixture();
    await pool.query("UPDATE academic_years SET closing_date='2049-08-24' WHERE start_year=2048");
    const request = { optimisticToken: fixture.optimisticToken, replacementLaboratoryDate: "2049-08-17" };
    expect(await previewOvpsaClinicClosureBatchRecovery(fixture.batchId, request, admin)).toMatchObject({
      movedPhysicalExamCount: 1, allocations: [{ proposedPhysicalExamDate: "2049-08-24", physicalExamAction: "MOVE" }],
    });
    await confirmOvpsaClinicClosureBatchRecovery(fixture.batchId, { ...request,
      caseTokens: [{ caseId: fixture.manual.id, expectedOptimisticToken: fixture.manual.optimistic_token }], reason: "Review batch dates" }, admin);
    expect((await pool.query("SELECT appointment_date::text FROM appointments WHERE student_number='UCAL-OVPSA-BOUND' AND is_published ORDER BY schedule_type")).rows)
      .toEqual([{ appointment_date: "2049-08-17" }, { appointment_date: "2049-08-24" }]);
  });
  it("revalidates shortened batch bounds at confirmation", async () => {
    const fixture = await ovpsaClosureFixture();
    const request = { optimisticToken: fixture.optimisticToken, replacementLaboratoryDate: "2049-08-17" };
    expect((await previewOvpsaClinicClosureBatchRecovery(fixture.batchId, request, admin)).movedPhysicalExamCount).toBe(1);
    await pool.query("UPDATE academic_years SET closing_date='2049-08-23' WHERE start_year=2048");
    await expect(confirmOvpsaClinicClosureBatchRecovery(fixture.batchId, { ...request,
      caseTokens: [{ caseId: fixture.manual.id, expectedOptimisticToken: fixture.manual.optimistic_token }], reason: "Review batch dates" }, admin))
      .rejects.toMatchObject({ code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE", status: 409 });
  });
  it("rejects an individual OVPSA PE replacement earlier than seven days after Laboratory", async () => {
    const fixture = await ovpsaClosureFixture(false);
    await expect(resolveClinicClosureManualCase(fixture.manual.id, {
      action: "ASSIGN_REPLACEMENT", expectedOptimisticToken: fixture.manual.optimistic_token,
      preserveLaboratory: true, physicalExamDate: "2049-08-20", reason: "Review individual PE date",
    }, admin)).rejects.toMatchObject({ code: "PAIR_ORDER_VIOLATION" });
  });
});


describe("closure recovery protected occupancy", () => {
  it("keeps a preserved PE occupied for the next student", async () => {
    await createPair({ studentNumber: "UCAL-KEEP-A", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-12" });
    await createPair({ studentNumber: "UCAL-KEEP-B", laboratoryDate: "2049-08-08", physicalExamDate: "2049-08-10" });
    await insertPublishedCapacityOccupant({ studentNumber: "UCAL-KEEP-C", appointmentDate: "2049-08-11", status: "PENDING", scheduleType: "PHYSICAL_EXAM" });
    // Block B's otherwise earliest PE date with an occupied Physical Examination slot.
    await pool.query("UPDATE clinic_capacity_settings SET max_daily_capacity=1,safe_daily_capacity=1");
    await saveClinicCalendarChanges({ requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "AUTO_ELIGIBLE", changes: [
      { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED preserved" },
      { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED preserved" },
    ] }, admin);
    expect((await pool.query("SELECT appointment_date::text FROM appointments WHERE student_number='UCAL-KEEP-B' AND schedule_type='PHYSICAL_EXAM' AND is_published")).rows)
      .toEqual([{ appointment_date: "2049-08-13" }]);
    expect((await pool.query("SELECT status,appointment_date::text FROM appointments WHERE student_number='UCAL-KEEP-A' AND schedule_type='PHYSICAL_EXAM'")).rows)
      .toEqual([{ status: "PENDING", appointment_date: "2049-08-12" }]);
  });
  it("discards a failed student's simulated release and reservation", async () => {
    await createPair({ studentNumber: "UCAL-FAIL-A", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-11" });
    await createPair({ studentNumber: "UCAL-FAIL-B", laboratoryDate: "2049-08-08", physicalExamDate: "2049-08-10" });
    await pool.query("UPDATE clinic_capacity_settings SET max_daily_capacity=1,safe_daily_capacity=1");
    await pool.query(`CREATE FUNCTION task4_move_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.student_number='UCAL-FAIL-A' AND NEW.status='RESCHEDULED' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER task4_move_failure BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION task4_move_failure()");
    try {
      expect(await saveClinicCalendarChanges({ requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "AUTO_ELIGIBLE", changes: [
        { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED rollback slots" },
        { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED rollback slots" },
      ] }, admin)).toMatchObject({ movedStudentCount: 1, manualCaseCount: 1 });
      expect((await pool.query("SELECT appointment_date::text FROM appointments WHERE student_number='UCAL-FAIL-B' AND schedule_type='PHYSICAL_EXAM' AND is_published")).rows)
        .toEqual([{ appointment_date: "2049-08-12" }]);
      expect((await pool.query("SELECT status FROM appointments WHERE student_number='UCAL-FAIL-A' AND schedule_type='PHYSICAL_EXAM'")).rows)
        .toEqual([{ status: "PENDING" }]);
    } finally {
      await pool.query("DROP TRIGGER task4_move_failure ON appointments");
      await pool.query("DROP FUNCTION task4_move_failure()");
    }
  });
  it("does not count external OVPSA Laboratory in a capacity reduction", async () => {
    const lineage = await createReleasedOvpsaLaboratoryLineage("2049-08-16");
    await insertPublishedCapacityOccupant({ studentNumber: "UCAL-EXTERNAL-A", appointmentDate: "2049-08-16", status: "PENDING", ovpsaLineage: lineage });
    await insertPublishedCapacityOccupant({ studentNumber: "UCAL-INTERNAL-B", appointmentDate: "2049-08-16", status: "PENDING" });
    expect(await changeCapacity({ clinicCode: "KABALAKA_CLINIC", scheduleType: "LABORATORY", maxDailyCapacity: 1 }, admin.userId))
      .toMatchObject({ maxDailyCapacity: 1 });
    await pool.query("DELETE FROM audit_logs WHERE action='CAPACITY_UPDATED'");
  });
  it.each(["today", "expired"])("keeps ordinary %s manual cases unresolved", async (state) => {
    await createPair({ studentNumber: "UCAL-TODAY", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-10" });
    await saveClinicCalendarChanges({ requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "MANUAL_ALL", changes: [
      { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED today" },
      { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED today" },
    ] }, admin);
    const row = (await pool.query("SELECT id,optimistic_token FROM clinic_closure_manual_cases WHERE student_number='UCAL-TODAY'")).rows[0];
    if (state === "expired") await pool.query("UPDATE academic_years SET closing_date='2049-08-10' WHERE start_year=2048");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2049-08-11T00:00:00Z"));
    try {
      await expect(resolveClinicClosureManualCase(row.id, { action: "ASSIGN_REPLACEMENT", expectedOptimisticToken: row.optimistic_token,
        laboratoryDate: state === "today" ? "2049-08-11" : "2049-08-12", physicalExamDate: "2049-08-13", reason: "Reviewed replacement dates" }, admin))
        .rejects.toMatchObject({ code: state === "today" ? "APPOINTMENT_DATE_IN_PAST" : "ACADEMIC_YEAR_ENDED" });
      expect((await pool.query("SELECT status FROM clinic_closure_manual_cases WHERE id=$1", [row.id])).rows[0].status).toBe("OPEN");
    } finally { vi.useRealTimers(); }
  });
  it.each(["LABORATORY", "PHYSICAL_EXAM"])("does not move a manually locked OVPSA %s in coordinated recovery", async (scheduleType) => {
    const fixture = await ovpsaClosureFixture();
    await pool.query(`UPDATE appointments SET is_manually_locked=TRUE,locked_by=$1,locked_at=NOW(),lock_reason='Protected PE'
      WHERE student_number='UCAL-OVPSA-BOUND' AND schedule_type=$2`, [admin.userId, scheduleType]);
    await expect(previewOvpsaClinicClosureBatchRecovery(fixture.batchId, {
      optimisticToken: fixture.optimisticToken, replacementLaboratoryDate: "2049-08-17",
    }, admin)).rejects.toMatchObject({ code: "OVPSA_PROTECTED_APPOINTMENT_CONFLICT", status: 409 });
  });
});


it("keeps the completed OVPSA Laboratory reservation while releasing the affected PE reservation", async () => {
  const fixture = await ovpsaClosureFixture(false, true);
  expect((await pool.query("SELECT schedule_type,status FROM ovpsa_first_year_service_reservations WHERE batch_id=$1 ORDER BY schedule_type", [fixture.batchId])).rows)
    .toEqual([{ schedule_type: "LABORATORY", status: "ACTIVE" }, { schedule_type: "PHYSICAL_EXAM", status: "RELEASED" }]);
  expect((await pool.query("SELECT status FROM appointments WHERE student_number='UCAL-OVPSA-BOUND' ORDER BY schedule_type")).rows)
    .toEqual([{ status: "COMPLETED" }, { status: "AWAITING_RESCHEDULE" }]);
});


describe("mixed block and reopening preview agreement", () => {
  it.each([
    { reservedService: null, reservedDate: "2049-08-11", recovered: 1 },
    { reservedService: "LABORATORY", reservedDate: "2049-08-11", recovered: 0 },
    { reservedService: "PHYSICAL_EXAM", reservedDate: "2049-08-12", recovered: 0 },
    { reservedService: "PHYSICAL_EXAM", reservedDate: "2049-08-11", recovered: 1 },
  ])("matches confirmation with $reservedService reserved on $reservedDate", async ({ reservedService, reservedDate, recovered }) => {
    const initial = await saveClinicCalendarChanges({
      requestId: requestIds.pair, emergencyAcknowledged: false, recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "BLOCK", date: "2049-08-11", category: "CLOSURE", reason: "TEST-UNIFIED mixed preview" }],
    }, admin);
    const reopening = initial.activeUnavailableDates.find((date) => date.blockedDate === "2049-08-11")!;
    let reservationId: string | undefined;
    if (reservedService) {
      const lineage = await createReleasedOvpsaLaboratoryLineage("2049-08-16");
      reservationId = (await pool.query(`INSERT INTO ovpsa_first_year_service_reservations
        (batch_id,revision_id,schedule_type,reservation_date,status,reservation_kind,created_by)
        VALUES($1,$2,$3,$4,'ACTIVE','EXCLUSIVE',$5) RETURNING id`,
      [lineage.batchId, lineage.revisionId, reservedService, reservedDate, admin.userId])).rows[0].id;
    }
    await pool.query("UPDATE academic_years SET closing_date='2049-08-12' WHERE start_year=2048");
    await createPair({ studentNumber: "UCAL-MIXED-REOPEN", laboratoryDate: "2049-08-09", physicalExamDate: "2049-08-10" });
    const request = {
      requestId: requestIds.pairReopenOne, emergencyAcknowledged: false,
      changes: [
        { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED mixed preview" },
        { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED mixed preview" },
        { action: "REOPEN", date: reopening.blockedDate, unavailableDateId: reopening.id, expectedUpdatedAt: reopening.updatedAt },
      ],
    };
    const preview = await previewClinicCalendarChanges(request, admin);
    expect(preview).toMatchObject({ automaticRecoveryEligibleCount: recovered, manualResolutionRequiredCount: 1 - recovered });
    // A preview simulates availability without reopening the actual calendar or changing appointments.
    expect((await pool.query("SELECT reopened_at FROM clinic_unavailable_dates WHERE id=$1", [reopening.id])).rows[0].reopened_at).toBeNull();
    expect((await pool.query("SELECT id FROM appointments WHERE student_number='UCAL-MIXED-REOPEN'")).rowCount).toBe(2);
    const saved = await saveClinicCalendarChanges({ ...request, recoveryMode: "AUTO_ELIGIBLE" }, admin);
    expect(saved).toMatchObject({ reopenedDateCount: 1, movedStudentCount: recovered, manualCaseCount: 1 - recovered });
    expect(saved.movedStudentCount).toBe(preview.automaticRecoveryEligibleCount);
    expect(saved.manualCaseCount).toBe(preview.manualResolutionRequiredCount);
    if (recovered) {
      expect((await pool.query("SELECT schedule_type,appointment_date::text FROM appointments WHERE student_number='UCAL-MIXED-REOPEN' AND is_published ORDER BY schedule_type")).rows)
        .toEqual([{ schedule_type: "LABORATORY", appointment_date: "2049-08-11" }, { schedule_type: "PHYSICAL_EXAM", appointment_date: "2049-08-12" }]);
    } else {
      expect(saved.manualReasonGroups).toEqual([expect.objectContaining({ reasonCode: "NO_VALID_REPLACEMENT_WITHIN_CYCLE" })]);
    }
    if (reservationId) {
      expect((await pool.query("SELECT schedule_type,reservation_date::text,status FROM ovpsa_first_year_service_reservations WHERE id=$1", [reservationId])).rows)
        .toEqual([{ schedule_type: reservedService, reservation_date: reservedDate, status: "ACTIVE" }]);
    }
  });
});
