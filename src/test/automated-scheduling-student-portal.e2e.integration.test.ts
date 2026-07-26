// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { appointmentSummaryReport } from "@/server/repositories/appointment-summary.repository";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import { authenticateStudent } from "@/server/services/student-auth.service";
import {
  createClinicUnavailableDate,
  saveClinicCalendarChanges,
} from "@/server/services/clinic-calendar.service";
import { acceptAndScheduleImport } from "@/server/services/schedule-imports.service";
import { resolveSchedulingWindow } from "@/server/services/scheduling-window";
import { updateAppointment } from "@/server/services/appointments.service";
import {
  addStudentResultFile,
  createAdminSubmissionZip,
  finalizeStudentResultSubmission,
  getAdminStudentResultProfile,
  getAdminStudentResultFile,
  getStudentResultFile,
  getStudentResultSubmission,
  invalidateStudentResultSubmission,
  listAdminStudentResultProfiles,
} from "@/server/services/student-result-submissions.service";
import { LocalResultStorage } from "@/server/storage/local-result-storage";
import {
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";

const header = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const studentPattern = "99-90%";
const importPattern = "% 2026-2027 - TEST-E2E%";
let storageRoot = "";
let storage: LocalResultStorage;
let capacityFixture: CapacityFixtureLock | null = null;

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};
const laboratoryStaff: SessionUser = {
  userId: TEST_REFERENCE_IDS.clinicStaffUser,
  fullName: "Clinic Staff",
  email: "staff@medclinic.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
};

function importInput(
  filename: string,
  category: "REGULAR" | "OJT",
  studentNumbers: string[],
) {
  const contents = [
    header,
    ...studentNumbers.map((studentNumber, index) => (
      `${studentNumber},E2E,Student${index + 1},,,College of Computer Studies,BSIT,3,05-06-2003`
    )),
  ].join("\n");
  return {
    fileName: filename,
    fileSize: Buffer.byteLength(contents),
    contents,
    studentCategory: category,
    academicYearStart: 2026,
    preferredMonth: category === "REGULAR" ? null : 8,
  };
}

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  // This fixture owns both active and soft-unblocked rows identified by its reason prefix.
  await pool.query("DELETE FROM clinic_unavailable_dates WHERE reason LIKE 'TEST-E2E%'");
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true });
    storageRoot = await mkdtemp(join(tmpdir(), "medclinic-e2e-results-"));
    storage = new LocalResultStorage(storageRoot);
  }
}

async function finalCleanup() {
  let failure: unknown;
  try {
    await cleanup();
  } catch (error) {
    failure = error;
  }
  try {
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, async () => {
    try {
      storageRoot = await mkdtemp(join(tmpdir(), "medclinic-e2e-results-"));
      storage = new LocalResultStorage(storageRoot);
      await cleanup();
    } catch (error) {
      if (storageRoot) {
        await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  });
});

afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, finalCleanup);
});

describe("automated academic-year scheduling and student results", () => {
  it("runs the complete import, displacement, closure, portal, document, and replacement story", async () => {
    await pool.query(
      `UPDATE clinic_capacity_settings
          SET safe_daily_capacity=1, max_daily_capacity=1
        WHERE id IN ($1,$2)`,
      [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      ],
    );
    const preImportBlockedDate = "2026-08-04";
    const preImportBlock = await saveClinicCalendarChanges({
      changes: [{
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        date: preImportBlockedDate,
        category: "MAINTENANCE",
        reason: "TEST-E2E import calendar block",
      }],
    }, admin);
    expect(preImportBlock).toMatchObject({
      blockedDateCount: 1,
      movedStudentCount: 0,
      movedAppointmentCount: 0,
    });
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by, created_batch_id
       )
       SELECT closure.clinic_id, blocked_date::date, blocked_date::date,
              'CLOSURE', closure.reason, $3, gen_random_uuid()
         FROM (VALUES
           ($1::uuid, 'TEST-E2E capacity laboratory'),
           ($2::uuid, 'TEST-E2E capacity physical')
         ) AS closure(clinic_id, reason)
         CROSS JOIN generate_series(
           DATE '2026-08-05', DATE '2026-08-31', INTERVAL '1 day'
         ) AS blocked_date`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );

    const regular = await acceptAndScheduleImport(
      importInput("TEST-E2E-regular.csv", "REGULAR", ["99-9001-01", "99-9002-02"]),
      admin,
    );
    expect(regular.status).toBe("PUBLISHED");
    const accepted = await pool.query<{ accepted_at: Date }>(
      "SELECT accepted_at FROM schedule_import_groups WHERE id=$1",
      [regular.importId],
    );
    const earliest = resolveSchedulingWindow({
      category: "REGULAR",
      academicYearStart: 2026,
      preferredMonth: null,
      acceptedAt: accepted.rows[0].accepted_at.toISOString(),
      timeZone: "Asia/Manila",
    });
    expect(regular.generatedRange!.startDate >= earliest).toBe(true);
    expect(regular.generatedRange!.startDate.startsWith("2026-08-")).toBe(true);
    const appointmentsOnPreImportBlock = await pool.query(
      `SELECT id FROM appointments
        WHERE student_number LIKE $1 AND clinic_id=$2 AND appointment_date=$3::date
          AND status NOT IN ('RESCHEDULED','CANCELLED')`,
      [studentPattern, TEST_REFERENCE_IDS.laboratoryClinic, preImportBlockedDate],
    );
    expect(appointmentsOnPreImportBlock.rows).toHaveLength(0);

    const priority = await acceptAndScheduleImport(
      importInput("TEST-E2E-priority.csv", "OJT", ["99-9003-03"]),
      admin,
    );
    expect(priority).toMatchObject({ status: "PUBLISHED", displacementTotal: 1 });
    const displacement = await pool.query(
      "SELECT student_number, cause FROM appointment_reschedule_events WHERE cause='PRIORITY_DISPLACEMENT' AND student_number LIKE $1",
      [studentPattern],
    );
    expect(displacement.rows).toHaveLength(1);

    const currentPair = async () => pool.query<{ id: string; schedule_type: string; appointment_date: string }>(
      `SELECT id, schedule_type, appointment_date::text
         FROM appointments
        WHERE student_number='99-9003-03' AND status='PENDING'
        ORDER BY schedule_type`,
    );
    const beforeCpu = await currentPair();
    const physicalBefore = beforeCpu.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
      startDate: physicalBefore.appointment_date,
      endDate: physicalBefore.appointment_date,
      category: "CLOSURE",
      reason: "TEST-E2E CPU closure",
    }, admin);
    const afterCpu = await currentPair();
    expect(afterCpu.rows.find((row) => row.schedule_type === "LABORATORY")?.id)
      .toBe(beforeCpu.rows.find((row) => row.schedule_type === "LABORATORY")?.id);
    expect(afterCpu.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")?.id)
      .not.toBe(physicalBefore.id);

    const laboratoryBefore = afterCpu.rows.find((row) => row.schedule_type === "LABORATORY")!;
    const kabalakaClosure = await saveClinicCalendarChanges({
      changes: [{
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        date: laboratoryBefore.appointment_date,
        category: "MAINTENANCE",
        reason: "TEST-E2E KABALAKA closure",
      }],
    }, admin);
    expect(kabalakaClosure).toMatchObject({ movedStudentCount: 1, movedAppointmentCount: 2 });
    const movedPair = await currentPair();
    expect(movedPair.rows).toHaveLength(2);
    expect(movedPair.rows.some((row) => row.id === laboratoryBefore.id)).toBe(false);
    const activeKabalakaBlock = kabalakaClosure.activeUnavailableDates.find((record) => (
      record.clinicId === TEST_REFERENCE_IDS.laboratoryClinic
      && record.startDate === laboratoryBefore.appointment_date
    ));
    expect(activeKabalakaBlock).toBeDefined();

    const restored = await saveClinicCalendarChanges({
      changes: [{
        action: "UNBLOCK",
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        date: laboratoryBefore.appointment_date,
        unavailableDateId: activeKabalakaBlock!.id,
        expectedUpdatedAt: activeKabalakaBlock!.updatedAt,
      }],
    }, admin);
    expect(restored).toMatchObject({
      unblockedDateCount: 1,
      restoredStudentCount: 1,
      restoredAppointmentCount: 2,
    });
    expect(restored.activeUnavailableDates).not.toContainEqual(expect.objectContaining({
      id: activeKabalakaBlock!.id,
    }));

    const activePair = await currentPair();
    expect(activePair.rows.map((appointment) => appointment.id).sort()).toEqual(
      afterCpu.rows.map((appointment) => appointment.id).sort(),
    );
    const lifecycleAppointments = await pool.query<{
      id: string;
      status: string;
      is_published: boolean;
      rescheduled_from: string | null;
    }>(
      `SELECT id::text, status, is_published, rescheduled_from::text
         FROM appointments
        WHERE id=ANY($1::uuid[])
        ORDER BY id`,
      [[...afterCpu.rows, ...movedPair.rows].map((appointment) => appointment.id)],
    );
    for (const original of afterCpu.rows) {
      expect(lifecycleAppointments.rows.find((row) => row.id === original.id)).toMatchObject({
        status: "PENDING",
        is_published: true,
      });
    }
    for (const replacement of movedPair.rows) {
      expect(lifecycleAppointments.rows.find((row) => row.id === replacement.id)).toMatchObject({
        status: "RESCHEDULED",
        is_published: false,
        rescheduled_from: expect.any(String),
      });
      expect(afterCpu.rows.map((appointment) => appointment.id)).toContain(
        lifecycleAppointments.rows.find((row) => row.id === replacement.id)?.rescheduled_from,
      );
    }
    const restorationNotifications = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM student_portal_notifications
        WHERE student_number='99-9003-03'
          AND notification_type='SCHEDULE_RESCHEDULED'
          AND metadata->>'batchId'=$1
          AND metadata->>'restored'='true'`,
      [restored.batchId],
    );
    expect(restorationNotifications.rows[0].count).toBe(1);

    await expect(authenticateStudent({
      studentNumber: " 99-9003-03 ",
      dateOfBirth: "2003-05-06",
      ipAddress: "127.0.0.90",
    })).resolves.toEqual({ studentNumber: "99-9003-03", sessionType: "STUDENT" });
    const portal = await getStudentPortalSchedule("99-9003-03");
    expect(portal?.appointments.some((appointment) => "appointmentTime" in appointment)).toBe(false);
    expect(portal?.appointments.filter((appointment) => appointment.status === "PENDING")).toHaveLength(2);

    const laboratory = activePair.rows.find((row) => row.schedule_type === "LABORATORY")!;
    await updateAppointment(laboratory.id, { status: "COMPLETED" }, laboratoryStaff);
    const afterLaboratoryAttendance = await appointmentSummaryReport({
      search: "99-9003-03",
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(afterLaboratoryAttendance.items[0]).toMatchObject({
      laboratoryStatus: "COMPLETED",
      physicalExamStatus: "PENDING",
      overallStatus: "INCOMPLETE",
    });
    const pendingResult = await pool.query(
      "SELECT result_status FROM laboratory_results WHERE appointment_id=$1",
      [laboratory.id],
    );
    expect(pendingResult.rows).toEqual([{ result_status: "PENDING_UPLOAD" }]);

    const pdf = await addStudentResultFile("99-9003-03", laboratory.id, {
      filename: "synthetic-laboratory.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nnon-sensitive synthetic result"),
    }, storage);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await addStudentResultFile("99-9003-03", laboratory.id, {
      filename: "synthetic-laboratory.png",
      declaredMimeType: "image/png",
      bytes: pngBytes,
    }, storage);
    const finalized = await finalizeStudentResultSubmission("99-9003-03", laboratory.id, storage);
    expect(finalized).toMatchObject({ status: "FINALIZED", fileCount: 2 });
    const partial = await listAdminStudentResultProfiles(admin, {
      page: 1,
      limit: 50,
      offset: 0,
    });
    expect(partial.items.find((item) => item.studentNumber === "99-9003-03"))
      .toMatchObject({ studentName: "E2E, Student1", progress: "PARTIALLY_SUBMITTED" });

    const physical = activePair.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    await updateAppointment(physical.id, { status: "COMPLETED" }, admin);
    const afterPhysicalAttendance = await appointmentSummaryReport({
      search: "99-9003-03",
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(afterPhysicalAttendance.items[0]).toMatchObject({
      laboratoryStatus: "COMPLETED",
      physicalExamStatus: "COMPLETED",
      overallStatus: "COMPLETE",
    });
    await addStudentResultFile("99-9003-03", physical.id, {
      filename: "synthetic-physical-exam.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nnon-sensitive synthetic physical exam result"),
    }, storage);
    await finalizeStudentResultSubmission("99-9003-03", physical.id, storage);
    const fullySubmitted = await getAdminStudentResultProfile("99-9003-03", admin);
    expect(fullySubmitted).toMatchObject({
      progress: "FULLY_SUBMITTED",
      physicalExam: { state: "FINALIZED" },
    });

    await expect(getStudentResultFile("99-9003-03", pdf.id, storage))
      .resolves.toMatchObject({ filename: "synthetic-laboratory.pdf" });
    await expect(getStudentResultFile("99-9001-01", pdf.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    await expect(getAdminStudentResultFile(pdf.id, admin, storage))
      .resolves.toMatchObject({ filename: "synthetic-laboratory.pdf" });
    const zip = await createAdminSubmissionZip(finalized.id, admin, storage);
    expect(zip.subarray(0, 2).toString("ascii")).toBe("PK");

    await invalidateStudentResultSubmission(finalized.id, "Synthetic document replacement test", admin, storage);
    const awaiting = await getAdminStudentResultProfile("99-9003-03", admin);
    expect(awaiting).toMatchObject({ progress: "AWAITING_RESUBMISSION" });
    expect(awaiting?.laboratory).toMatchObject({
      state: "INVALIDATED",
      submission: {
        id: finalized.id,
        status: "INVALIDATED",
        invalidationReason: "Synthetic document replacement test",
        invalidatedAt: expect.any(Date),
      },
    });
    const reopened = await getStudentResultSubmission("99-9003-03", laboratory.id);
    expect(reopened).toMatchObject({ status: "DRAFT", fileCount: 0 });
    await expect(addStudentResultFile("99-9003-03", laboratory.id, {
      filename: "replacement.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nreplacement"),
    }, storage)).resolves.toMatchObject({ submissionId: reopened.id });
    const finalState = await pool.query(
      `SELECT appointment.status AS appointment_status, result.result_status,
              COUNT(notification.id)::int AS notification_count
         FROM appointments appointment
         JOIN laboratory_results result ON result.appointment_id=appointment.id
         LEFT JOIN student_portal_notifications notification
           ON notification.student_number=appointment.student_number
        WHERE appointment.id=$1
        GROUP BY appointment.status, result.result_status`,
      [laboratory.id],
    );
    expect(finalState.rows[0]).toMatchObject({
      appointment_status: "COMPLETED",
      result_status: "PENDING_UPLOAD",
      notification_count: expect.any(Number),
    });
    expect(finalState.rows[0].notification_count).toBeGreaterThanOrEqual(3);

    const replacementFinalized = await finalizeStudentResultSubmission(
      "99-9003-03",
      laboratory.id,
      storage,
    );
    const replaced = await getAdminStudentResultProfile("99-9003-03", admin);
    expect(replaced).toMatchObject({ progress: "FULLY_SUBMITTED" });
    expect(replaced?.laboratory).toMatchObject({ state: "FINALIZED" });
    const invalidatedHistory = replaced?.history.find((submission) => submission.id === finalized.id);
    expect(invalidatedHistory).toMatchObject({
      id: finalized.id,
      status: "INVALIDATED",
      invalidationReason: "Synthetic document replacement test",
      invalidatedAt: expect.any(Date),
    });

    const newerLaboratory = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by, updated_by
       ) SELECT clinic_id, student_number, schedule_type,
                (appointment_date + INTERVAL '1 year')::date,
                'PENDING', TRUE, $2, $2
           FROM appointments
          WHERE id=$1
       RETURNING id`,
      [laboratory.id, TEST_REFERENCE_IDS.adminUser],
    );
    const newerLaboratoryId = newerLaboratory.rows[0].id;
    const newCycle = await getAdminStudentResultProfile("99-9003-03", admin);
    expect(newCycle?.laboratory).toMatchObject({
      appointment: { id: newerLaboratoryId, status: "PENDING" },
      state: "NOT_SUBMITTED",
      submission: null,
    });
    expect(newCycle?.progress).toBe("PARTIALLY_SUBMITTED");
    expect(newCycle?.history.some((submission) => submission.id === replacementFinalized.id))
      .toBe(true);

    const afterNewLaboratoryCycle = await appointmentSummaryReport({
      search: "99-9003-03",
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(afterNewLaboratoryCycle.items[0]).toMatchObject({
      laboratoryStatus: "PENDING",
      physicalExamStatus: "COMPLETED",
      overallStatus: "INCOMPLETE",
    });
  }, 60000);

  it("rejects a protected CPU restoration without applying another clinic block", async () => {
    const protectedImport = await acceptAndScheduleImport(
      importInput("TEST-E2E-protected-restoration.csv", "OJT", ["99-9004-04"]),
      admin,
    );
    expect(protectedImport.status).toBe("PUBLISHED");

    const originals = await pool.query<{
      id: string;
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      appointment_date: string;
    }>(
      `SELECT id::text, schedule_type, appointment_date::text
         FROM appointments
        WHERE student_number='99-9004-04' AND status='PENDING' AND is_published=TRUE
        ORDER BY schedule_type`,
    );
    expect(originals.rows).toHaveLength(2);
    const originalLaboratory = originals.rows.find((row) => row.schedule_type === "LABORATORY")!;
    const originalPhysical = originals.rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!;
    const blocked = await saveClinicCalendarChanges({
      changes: [{
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
        date: originalPhysical.appointment_date,
        category: "CLOSURE",
        reason: "TEST-E2E protected restoration",
      }],
    }, admin);
    expect(blocked).toMatchObject({ movedStudentCount: 1, movedAppointmentCount: 1 });
    const activeBlock = blocked.activeUnavailableDates.find((record) => (
      record.clinicId === TEST_REFERENCE_IDS.physicalExamClinic
      && record.startDate === originalPhysical.appointment_date
    ));
    expect(activeBlock).toBeDefined();

    const replacement = await pool.query<{
      id: string;
      schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
      rescheduled_from: string;
    }>(
      `SELECT id::text, schedule_type, rescheduled_from::text
         FROM appointments
        WHERE rescheduled_from=$1 AND status='PENDING' AND is_published=TRUE`,
      [originalPhysical.id],
    );
    expect(replacement.rows).toEqual([expect.objectContaining({
      schedule_type: "PHYSICAL_EXAM",
      rescheduled_from: originalPhysical.id,
    })]);
    const currentLaboratory = await pool.query<{ id: string }>(
      `SELECT id::text FROM appointments
        WHERE student_number='99-9004-04' AND schedule_type='LABORATORY'
          AND status='PENDING' AND is_published=TRUE`,
    );
    expect(currentLaboratory.rows).toEqual([{ id: originalLaboratory.id }]);
    const protectedPhysical = replacement.rows[0];
    await pool.query(
      `INSERT INTO exam_results (student_number, appointment_id, result_status, encoded_by)
       VALUES ('99-9004-04',$1,'REQUIRES_FOLLOW_UP',$2)`,
      [protectedPhysical.id, admin.userId],
    );

    const atomicBlockCandidate = await pool.query<{ date: string }>(
      `SELECT candidate::date::text AS date
         FROM generate_series(DATE '2026-10-01', DATE '2026-12-31', INTERVAL '1 day') candidate
        WHERE EXTRACT(ISODOW FROM candidate) BETWEEN 1 AND 5
          AND NOT EXISTS (
            SELECT 1 FROM clinic_unavailable_dates unavailable
             WHERE unavailable.clinic_id=$1
               AND unavailable.unblocked_at IS NULL
               AND candidate::date BETWEEN unavailable.start_date AND unavailable.end_date
          )
          AND NOT EXISTS (
            SELECT 1 FROM appointments appointment
             WHERE appointment.clinic_id=$1
               AND appointment.appointment_date=candidate::date
               AND appointment.status NOT IN ('RESCHEDULED','CANCELLED')
          )
        ORDER BY candidate
        LIMIT 1`,
      [TEST_REFERENCE_IDS.laboratoryClinic],
    );
    expect(atomicBlockCandidate.rows).toHaveLength(1);

    await expect(saveClinicCalendarChanges({
      changes: [{
        action: "UNBLOCK",
        clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
        date: originalPhysical.appointment_date,
        unavailableDateId: activeBlock!.id,
        expectedUpdatedAt: activeBlock!.updatedAt,
      }, {
        action: "BLOCK",
        clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
        date: atomicBlockCandidate.rows[0].date,
        category: "MAINTENANCE",
        reason: "TEST-E2E atomic rollback companion",
      }],
    }, admin)).rejects.toMatchObject({
      code: "CLINIC_CALENDAR_BATCH_REJECTED",
      status: 409,
      details: { issues: [expect.objectContaining({ code: "PROTECTED_REPLACEMENT" })] },
    });

    const retainedBlock = await pool.query<{ unblocked_at: Date | null }>(
      "SELECT unblocked_at FROM clinic_unavailable_dates WHERE id=$1",
      [activeBlock!.id],
    );
    expect(retainedBlock.rows).toEqual([{ unblocked_at: null }]);
    const companionBlock = await pool.query(
      `SELECT id FROM clinic_unavailable_dates
        WHERE clinic_id=$1 AND start_date=$2::date AND unblocked_at IS NULL`,
      [TEST_REFERENCE_IDS.laboratoryClinic, atomicBlockCandidate.rows[0].date],
    );
    expect(companionBlock.rows).toHaveLength(0);
    const retainedAppointments = await pool.query<{ id: string; status: string; is_published: boolean }>(
      `SELECT id::text, status, is_published
         FROM appointments
        WHERE id=ANY($1::uuid[])
        ORDER BY id`,
      [[originalPhysical.id, protectedPhysical.id]],
    );
    expect(retainedAppointments.rows.find((row) => row.id === originalPhysical.id)).toMatchObject({
      status: "RESCHEDULED",
      is_published: true,
    });
    expect(retainedAppointments.rows.find((row) => row.id === protectedPhysical.id)).toMatchObject({
      status: "PENDING",
      is_published: true,
    });
  }, 60000);
});
