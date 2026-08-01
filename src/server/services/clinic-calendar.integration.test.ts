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
      completePairMoveCount: 1,
      expectedManualCaseCount: 0,
      closureGroups: [{ startDate: "2049-08-09", endDate: "2049-08-10" }],
    });
    await expect(pool.query("SELECT 1 FROM clinic_unavailable_dates")).resolves.toMatchObject({ rowCount: 0 });
  });

  it("moves a complete pair after the group end and returns an idempotent stored result", async () => {
    await createPair({
      studentNumber: "UCAL-PAIR",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    const request = {
      requestId: requestIds.pair,
      emergencyAcknowledged: false,
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
    const notifications = await pool.query<{ notification_type: string; event_key: string }>(
      `SELECT notification_type,event_key FROM student_portal_notifications
        WHERE student_number='UCAL-PAIR'`,
    );
    expect(notifications.rows).toEqual([{
      notification_type: "CLINIC_CLOSURE_RESCHEDULED",
      event_key: expect.stringMatching(/^clinic-closure:.+:rescheduled$/),
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
      changes: [{ action: "BLOCK", date: "2049-08-12", category: "CLOSURE", reason: "TEST-UNIFIED manual" }],
    }, admin);
    expect(result).toMatchObject({ blockedDateCount: 1, manualCaseCount: 1, movedAppointmentCount: 0 });
    const states = await pool.query<{ status: string }>(
      "SELECT status FROM appointments WHERE student_number='UCAL-MANUAL' ORDER BY schedule_type",
    );
    expect(states.rows).toEqual([{ status: "AWAITING_RESCHEDULE" }, { status: "AWAITING_RESCHEDULE" }]);
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
        physicalExam: expect.objectContaining({ date: "2049-08-13", status: "AWAITING_RESCHEDULE" }),
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
    const notificationTypes = await pool.query<{ notification_type: string }>(
      `SELECT notification_type FROM student_portal_notifications
        WHERE student_number='UCAL-MANUAL' ORDER BY created_at,id`,
    );
    expect(notificationTypes.rows).toEqual([
      { notification_type: "CLINIC_CLOSURE_AWAITING_RESCHEDULE" },
      { notification_type: "CLINIC_CLOSURE_MANUALLY_RESOLVED" },
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

  it("waits for complete reopening and then restores the original pair atomically", async () => {
    await createPair({
      studentNumber: "UCAL-RESTORE",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    const blocked = await saveClinicCalendarChanges({
      requestId: requestIds.pair,
      emergencyAcknowledged: false,
      changes: [
        { action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED restore" },
        { action: "BLOCK", date: "2049-08-10", category: "CLOSURE", reason: "TEST-UNIFIED restore" },
      ],
    }, admin);
    const first = blocked.activeUnavailableDates.find((date) => date.blockedDate === "2049-08-09")!;
    const second = blocked.activeUnavailableDates.find((date) => date.blockedDate === "2049-08-10")!;
    const partial = await saveClinicCalendarChanges({
      requestId: requestIds.pairReopenOne,
      emergencyAcknowledged: false,
      changes: [{ action: "REOPEN", date: first.blockedDate, unavailableDateId: first.id, expectedUpdatedAt: first.updatedAt }],
    }, admin);
    expect(partial.restoredAppointmentCount).toBe(0);
    const final = await saveClinicCalendarChanges({
      requestId: requestIds.pairReopenTwo,
      emergencyAcknowledged: false,
      changes: [{ action: "REOPEN", date: second.blockedDate, unavailableDateId: second.id, expectedUpdatedAt: second.updatedAt }],
    }, admin);
    expect(final).toMatchObject({ restoredStudentCount: 1, restoredAppointmentCount: 2 });
    const current = await pool.query<{ appointment_date: string; status: string }>(
      `SELECT appointment_date::text,status FROM appointments
        WHERE student_number='UCAL-RESTORE' AND is_published=TRUE ORDER BY appointment_date`,
    );
    expect(current.rows).toEqual([
      { appointment_date: "2049-08-09", status: "PENDING" },
      { appointment_date: "2049-08-10", status: "PENDING" },
    ]);
    const notificationTypes = await pool.query<{ notification_type: string }>(
      `SELECT notification_type FROM student_portal_notifications
        WHERE student_number='UCAL-RESTORE' ORDER BY created_at,id`,
    );
    expect(notificationTypes.rows).toEqual([
      { notification_type: "CLINIC_CLOSURE_RESCHEDULED" },
      { notification_type: "CLINIC_CLOSURE_SCHEDULE_RESTORED" },
    ]);
  });

  it("retains replacements and creates a draft-specific case when protection changes before restoration", async () => {
    await createPair({
      studentNumber: "UCAL-RESTORE-DRAFT",
      laboratoryDate: "2049-08-09",
      physicalExamDate: "2049-08-10",
    });
    const blocked = await saveClinicCalendarChanges({
      requestId: requestIds.restorationDraftBlock,
      emergencyAcknowledged: false,
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
      changes: unavailable.map((date) => ({
        action: "REOPEN" as const,
        date: date.blockedDate,
        unavailableDateId: date.id,
        expectedUpdatedAt: date.updatedAt,
      })),
    }, admin);
    expect(reopened).toMatchObject({ restoredAppointmentCount: 0, restoredStudentCount: 0 });

    const cases = await listClinicClosureManualCases({
      page: 1,
      pageSize: 20,
      search: "UCAL-RESTORE-DRAFT",
    }, admin);
    expect(cases.items[0]).toMatchObject({
      reasonCode: "DRAFT_RESULT_FILES_EXIST",
      currentAssignmentBlock: expect.objectContaining({ code: "DRAFT_RESULT_FILES_EXIST" }),
    });
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
      changes: [{ action: "BLOCK", date: "2049-08-09", category: "CLOSURE", reason: "TEST-UNIFIED forbidden" }],
    }, staff)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("does not retain compatibility for clinicId or UNBLOCK", async () => {
    await expect(saveClinicCalendarChanges({
      requestId: randomUUID(),
      emergencyAcknowledged: false,
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
