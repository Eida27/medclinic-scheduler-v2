// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { TEST_REFERENCE_IDS, insertTestStudent } from "@/test/integration-fixtures";
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
  resolveClinicClosureManualCase,
  saveClinicCalendarChanges,
} from "./clinic-calendar.service";

const studentPattern = "UCAL-%";
let capacityFixture: CapacityFixtureLock | null = null;
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
      `DELETE FROM student_portal_notifications
        WHERE student_number LIKE $1`,
      [studentPattern],
    );
    await client.query(
      `DELETE FROM email_outbox
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
    await client.query("DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM appointments WHERE student_number LIKE $1)", [studentPattern]);
    await client.query("DELETE FROM exam_results WHERE student_number LIKE $1", [studentPattern]);
    await client.query("DELETE FROM laboratory_results WHERE student_number LIKE $1", [studentPattern]);
    await client.query("DELETE FROM student_result_submissions WHERE student_number LIKE $1", [studentPattern]);
    await client.query("DELETE FROM appointments WHERE student_number LIKE $1", [studentPattern]);
    await client.query("DELETE FROM students WHERE student_number LIKE $1", [studentPattern]);
    await client.query(
      `DELETE FROM clinic_unavailable_dates
        WHERE closure_group_id IN (
          SELECT id FROM clinic_closure_groups WHERE reason LIKE 'TEST-UNIFIED%'
        )`,
    );
    await client.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'TEST-UNIFIED%'");
  });
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
  await pool.query(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,is_manually_locked,locked_by,locked_at,lock_reason
     ) VALUES
       ($1,$3,'LABORATORY',$4,$6,TRUE,$8,2048,FALSE,NULL,NULL,NULL),
       ($2,$3,'PHYSICAL_EXAM',$5,$7,TRUE,$8,2048,$9,
        CASE WHEN $9 THEN $10::uuid ELSE NULL END,
        CASE WHEN $9 THEN NOW() ELSE NULL END,
        CASE WHEN $9 THEN 'TEST-UNIFIED protected appointment' ELSE NULL END)`,
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
afterEach(async () => {
  if (!capacityFixture) return;
  await cleanupAndRestoreCapacitySettings(pool, capacityFixture.originalCapacities, cleanup);
});
afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, cleanup);
});

describe("unified clinic calendar lifecycle", () => {
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
    const manualCase = (await listClinicClosureManualCases({
      search: "UCAL-MANUAL-ALL",
    }, admin)).items[0];
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
      `SELECT scheduling_category,scheduling_accepted_at,
              scheduling_source_row_order,scheduling_window_start::text,
              scheduling_window_end::text,schedule_pair_id::text,schedule_cycle_start
         FROM appointments
        WHERE student_number='UCAL-AUTO-DISPLACE' AND rescheduled_from IS NOT NULL
        ORDER BY schedule_type`,
    );
    expect(replacements.rows).toEqual([
      {
        scheduling_category: "REGULAR",
        scheduling_accepted_at: new Date("2049-07-01T00:00:00.000Z"),
        scheduling_source_row_order: 42,
        scheduling_window_start: "2049-08-01",
        scheduling_window_end: "2050-03-31",
        schedule_pair_id: laboratory.schedule_pair_id,
        schedule_cycle_start: 2048,
      },
      {
        scheduling_category: "REGULAR",
        scheduling_accepted_at: new Date("2049-07-01T00:00:00.000Z"),
        scheduling_source_row_order: 42,
        scheduling_window_start: "2049-08-01",
        scheduling_window_end: "2050-03-31",
        schedule_pair_id: laboratory.schedule_pair_id,
        schedule_cycle_start: 2048,
      },
    ]);
    const resolutionAudit = await pool.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY created_at DESC LIMIT 1",
      [insertedCase.rows[0].id],
    );
    expect(resolutionAudit.rows).toEqual([{
      action: "AUTOMATIC_DISPLACEMENT_MANUAL_CASE_RESOLVED",
    }]);
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

  it("preserves completed Laboratory and moves only Physical Examination", async () => {
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
    expect(result).toMatchObject({ movedStudentCount: 1, movedAppointmentCount: 1 });
    const laboratory = await pool.query(
      "SELECT status,is_published,appointment_date::text FROM appointments WHERE student_number='UCAL-PHYSICAL' AND schedule_type='LABORATORY'",
    );
    expect(laboratory.rows).toEqual([{ status: "COMPLETED", is_published: true, appointment_date: "2049-08-09" }]);
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
