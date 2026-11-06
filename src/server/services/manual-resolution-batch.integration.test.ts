import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import {
  cleanupTestFixtures,
  insertTestScheduleImportGroup,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import {
  getManualResolutionAvailability,
  previewManualResolutionBatch,
  resolveManualResolutionBatch,
  selectManualResolutionCases,
} from "./manual-resolution-batch.service";

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
};
const academicYearStart = 2087;
const laboratoryDate = `${academicYearStart}-09-01`;
const originalPhysicalExamDate = `${academicYearStart}-09-02`;
const replacementMonth = `${academicYearStart}-10`;
const replacementDate = `${replacementMonth}-06`;
const fixtureName = `BMR-${randomUUID().slice(0, 8)}`;
const students = [`${fixtureName}-1`, `${fixtureName}-2`];
const requestId = randomUUID();
const failureMessage = "Forced failure on the second bulk manual resolution case";
let createdAcademicYear = false;

async function seedBatch() {
  for (const studentNumber of students) {
    await insertTestStudent({ studentNumber, firstName: "Batch", lastName: "Resolution", yearLevel: 2 });
  }
  return transaction(async (client) => {
    const year = await client.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,$2,$3,$3) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
      [academicYearStart, `${academicYearStart + 1}-07-31`, admin.userId],
    );
    await client.query(
      `UPDATE students SET email=lower(student_number) || '@example.test',email_verified_at=NOW()
       WHERE student_number=ANY($1::text[])`,
      [students],
    );
    const importGroupId = await insertTestScheduleImportGroup(client, {
      name: fixtureName,
      sourceFilename: `${fixtureName}.csv`,
      academicYearStart,
      importMode: "STANDARD",
      actor: admin.userId,
    });
    await client.query(
      `INSERT INTO student_academic_snapshots
         (student_number,academic_year_start,student_name,college_id,college_name,
          program_id,program_code,program_name,year_level,source_import_group_id)
       SELECT student.student_number,$2,concat_ws(' ',student.first_name,student.last_name),
              college.id,college.name,program.id,program.code,program.name,student.year_level,$3
         FROM students student
         JOIN colleges college ON college.id=student.college_id
         JOIN programs program ON program.id=student.program_id
        WHERE student.student_number=ANY($1::text[])`,
      [students, academicYearStart, importGroupId],
    );
    const labBatchId = randomUUID();
    const peBatchId = randomUUID();
    const { laboratoryClinic, physicalExamClinic } = TEST_REFERENCE_IDS;
    await client.query(
      `INSERT INTO schedule_batches (id,clinic_id,batch_name,status,created_by,import_group_id)
       VALUES ($1,$3,$5,'PUBLISHED',$6,$7),($2,$4,$5,'PUBLISHED',$6,$7)`,
      [labBatchId, peBatchId, laboratoryClinic, physicalExamClinic, fixtureName, admin.userId, importGroupId],
    );
    const pairs = [];
    for (const studentNumber of students) {
      const pairId = randomUUID();
      const labId = randomUUID();
      const peId = randomUUID();
      await client.query(
        `INSERT INTO appointments
           (id,batch_id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
            schedule_pair_id,schedule_cycle_start,scheduling_category,created_by,updated_by)
         VALUES ($1,$3,$5,$7,'LABORATORY',$8,'PENDING',TRUE,$10,$11,'REGULAR',$12,$12),
                ($2,$4,$6,$7,'PHYSICAL_EXAM',$9,'AWAITING_RESCHEDULE',FALSE,$10,$11,'REGULAR',$12,$12)`,
        [labId, peId, labBatchId, peBatchId, laboratoryClinic, physicalExamClinic, studentNumber,
          laboratoryDate, originalPhysicalExamDate, pairId, academicYearStart, admin.userId],
      );
      await linkPublishedLaboratoryAppointments(client, [labId]);
      const { rows: [manualCase] } = await client.query<{ id: string; optimistic_token: string }>(
        `INSERT INTO clinic_closure_manual_cases
           (student_number,case_source,schedule_pair_id,schedule_cycle_start,
            affected_laboratory_appointment_id,affected_physical_exam_appointment_id,
            reason_code,reason_message,policy_metadata)
         VALUES ($1,'AUTOMATIC_DISPLACEMENT',$2,$3,$4,$5,
                 'NO_VALID_REPLACEMENT_WITHIN_CYCLE','Displaced Physical Exam','{}')
         RETURNING id::text,optimistic_token::text`,
        [studentNumber, pairId, academicYearStart, labId, peId],
      );
      await client.query(
        `INSERT INTO appointment_reschedule_events
           (student_number,schedule_pair_id,cause,source_import_group_id,old_laboratory_appointment_id,
            old_physical_exam_appointment_id,actor_user_id,manual_case_id,schedule_cycle_start,outcome)
         VALUES ($1,$2,'PRIORITY_DISPLACEMENT',$3,$4,$5,$6,$7,$8,'AWAITING_RESCHEDULE')`,
        [studentNumber, pairId, importGroupId, labId, peId, admin.userId, manualCase.id, academicYearStart],
      );
      pairs.push({ studentNumber, labId, peId, caseId: manualCase.id, token: manualCase.optimistic_token });
    }
    return { importGroupId, peBatchId, pairs, createdYear: year.rowCount === 1 };
  });
}

async function readBatchState(caseIds: string[]) {
  const [cases, appointments, events, effects] = await Promise.all([
    pool.query(
      `SELECT id,status,optimistic_token,resolved_by,resolution_details
         FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [caseIds],
    ),
    pool.query(
      `SELECT id,student_number,status,is_published,appointment_date::text,batch_id,rescheduled_from
         FROM appointments WHERE student_number=ANY($1::text[]) ORDER BY id`,
      [students],
    ),
    pool.query(
      `SELECT manual_case_id AS "caseId",outcome,old_laboratory_appointment_id AS "sourceLaboratoryId",
              new_laboratory_appointment_id AS "laboratoryAppointmentId",
              old_physical_exam_appointment_id AS "sourcePhysicalExamId",
              new_physical_exam_appointment_id AS "physicalExamAppointmentId"
         FROM appointment_reschedule_events WHERE manual_case_id=ANY($1::uuid[]) ORDER BY manual_case_id`,
      [caseIds],
    ),
    pool.query(
      `SELECT
         (SELECT count(*)::int FROM student_portal_notifications WHERE student_number=ANY($1::text[])) AS notifications,
         (SELECT count(*)::int FROM email_outbox WHERE student_number=ANY($1::text[])) AS emails,
         (SELECT count(*)::int FROM audit_logs
           WHERE entity_id=ANY($2::text[]) OR metadata->>'requestId'=$3::uuid::text) AS audits,
         (SELECT outcome FROM clinical_mutation_requests WHERE actor_user_id=$4 AND request_id=$3) AS replay`,
      [students, caseIds, requestId, admin.userId],
    ),
  ]);
  return { cases: cases.rows, appointments: appointments.rows, events: events.rows, effects: effects.rows[0] };
}

async function installSecondCaseFailure() {
  await transaction(async (client) => {
    await client.query(`
      CREATE FUNCTION test_fail_second_manual_resolution_case() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM audit_logs
                   WHERE action=NEW.action AND metadata->>'requestId'=TG_ARGV[0]) THEN
          RAISE EXCEPTION '${failureMessage}';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_fail_second_manual_resolution_case
        BEFORE INSERT ON audit_logs FOR EACH ROW
        WHEN (NEW.action='BULK_MANUAL_CASE_RESOLVED' AND NEW.metadata->>'requestId'='${requestId}')
        EXECUTE FUNCTION test_fail_second_manual_resolution_case('${requestId}');
    `);
  });
}

async function removeSecondCaseFailure() {
  await pool.query(`
    DROP TRIGGER IF EXISTS test_fail_second_manual_resolution_case ON audit_logs;
    DROP FUNCTION IF EXISTS test_fail_second_manual_resolution_case();
  `);
}

afterAll(async () => {
  try {
    await transaction(async (client) => {
      await client.query("DELETE FROM audit_logs WHERE metadata->>'requestId'=$1", [requestId]);
      await client.query("ALTER TABLE clinical_mutation_requests DISABLE TRIGGER clinical_mutation_requests_immutable");
      await client.query("DELETE FROM clinical_mutation_requests WHERE actor_user_id=$1 AND request_id=$2", [admin.userId, requestId]);
      await client.query("ALTER TABLE clinical_mutation_requests ENABLE TRIGGER clinical_mutation_requests_immutable");
      await client.query("DELETE FROM appointment_reschedule_events WHERE student_number=ANY($1::text[])", [students]);
      await client.query("DELETE FROM clinic_closure_manual_cases WHERE student_number=ANY($1::text[])", [students]);
    });
    await cleanupTestFixtures(`${fixtureName}-%`, fixtureName, fixtureName);
    if (createdAcademicYear) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [academicYearStart]);
  } finally {
    await pool.end();
  }
});

describe("bulk Manual Resolution", () => {
  it("rolls back a mid-batch failure and lets the same request retry and replay", async () => {
    const { importGroupId, peBatchId, pairs, createdYear } = await seedBatch();
    createdAcademicYear = createdYear;
    const caseIds = pairs.map((pair) => pair.caseId).sort();
    const initial = await readBatchState(caseIds);
    expect(initial.effects).toEqual({ notifications: 0, emails: 0, audits: 0, replay: null });

    const selection = await selectManualResolutionCases({ academicYearStart, importGroupId }, admin);
    expect(selection).toMatchObject({ total: 2, eligibleCount: 2, blockedCount: 0 });
    expect(selection.items.map((item) => item.caseId)).toEqual(caseIds);
    expect(await selectManualResolutionCases({ academicYearStart, importGroupId: randomUUID() }, admin))
      .toMatchObject({ total: 0, eligibleCount: 0, items: [] });
    const cases = selection.items.map(({ caseId, expectedOptimisticToken }) => ({ caseId, expectedOptimisticToken }));
    const payload = {
      cases, physicalExamDate: replacementDate, replaceRelatedServices: false,
      preservationAcknowledged: true, reason: "Reassign displaced Physical Exams.",
    };
    const availability = await getManualResolutionAvailability({
      cases, replaceRelatedServices: false, month: replacementMonth, service: "PHYSICAL_EXAM",
    }, admin);
    expect(availability.required).toBe(2);
    expect(availability.days).toHaveLength(31);
    expect(availability.days.find((day) => day.date === replacementDate)).toMatchObject({
      state: "AVAILABLE",
      capacity: [{ required: 2, projected: 2 }],
    });
    const preview = await previewManualResolutionBatch(payload, admin);
    expect(preview).toMatchObject({ studentCount: 2, appointmentCount: 2, previewToken: expect.any(String) });
    for (const pair of pairs) {
      expect(preview.rows.find((row) => row.caseId === pair.caseId)).toMatchObject({
        laboratory: { action: "PRESERVE", sourceId: pair.labId, newDate: laboratoryDate },
        physicalExam: { action: "MOVE", sourceId: pair.peId, newDate: replacementDate },
        issues: [],
      });
    }
    expect(await readBatchState(caseIds)).toEqual(initial);
    const request = { ...payload, requestId, previewToken: preview.previewToken };

    await installSecondCaseFailure();
    try {
      await expect(resolveManualResolutionBatch(request, admin)).rejects.toMatchObject({
        code: "P0001", message: failureMessage,
      });
    } finally {
      await removeSecondCaseFailure();
    }
    expect(await readBatchState(caseIds)).toEqual(initial);

    const outcome = await resolveManualResolutionBatch(request, admin);
    const committed = await readBatchState(caseIds);
    expect(committed.appointments).toHaveLength(6);
    expect(committed.effects).toEqual({ notifications: 2, emails: 2, audits: 5, replay: outcome });
    const mappings = pairs.map((pair) => {
      const replacement = committed.appointments.find((row) => row.rescheduled_from === pair.peId);
      expect(replacement).toMatchObject({
        student_number: pair.studentNumber, status: "PENDING", is_published: true,
        appointment_date: replacementDate, batch_id: peBatchId,
      });
      expect(committed.appointments.find((row) => row.id === pair.peId))
        .toMatchObject({ status: "RESCHEDULED", is_published: false });
      expect(committed.appointments.find((row) => row.id === pair.labId))
        .toEqual(initial.appointments.find((row) => row.id === pair.labId));
      const manualCase = committed.cases.find((row) => row.id === pair.caseId);
      expect(manualCase).toMatchObject({
        status: "RESOLVED",
        resolved_by: admin.userId,
        resolution_details: { bulkRequestId: requestId, physicalExamAppointmentId: replacement.id },
      });
      expect(manualCase.optimistic_token).not.toBe(pair.token);
      const mapping = {
        caseId: pair.caseId, sourceLaboratoryId: pair.labId, laboratoryAppointmentId: null,
        sourcePhysicalExamId: pair.peId, physicalExamAppointmentId: replacement.id,
      };
      expect(committed.events.find((row) => row.caseId === pair.caseId))
        .toEqual({ ...mapping, outcome: "MANUALLY_RESOLVED" });
      return mapping;
    });
    expect(outcome).toEqual({
      caseIds, mappings: mappings.sort((a, b) => a.caseId.localeCompare(b.caseId)),
      studentCount: 2, appointmentCount: 2, notificationWarningCount: 0,
    });
    expect(await resolveManualResolutionBatch(request, admin)).toEqual(outcome);
    await expect(resolveManualResolutionBatch({ ...request, reason: "Different resolution reason." }, admin))
      .rejects.toMatchObject({ code: "CLINICAL_REQUEST_CONFLICT" });
    expect(await readBatchState(caseIds)).toEqual(committed);
  });
});
