// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import { authenticateStudent } from "@/server/services/student-auth.service";
import { createClinicUnavailableDate } from "@/server/services/clinic-calendar.service";
import { acceptAndScheduleImport } from "@/server/services/schedule-imports.service";
import { resolveSchedulingWindow } from "@/server/services/scheduling-window";
import { updateAppointment } from "@/server/services/appointments.service";
import {
  addStudentResultFile,
  createAdminSubmissionZip,
  finalizeStudentResultSubmission,
  getAdminStudentResultFile,
  getStudentResultFile,
  getStudentResultSubmission,
  invalidateStudentResultSubmission,
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
    await pool.query(
      `INSERT INTO clinic_unavailable_dates (
         clinic_id, start_date, end_date, category, reason, created_by
       ) VALUES
         ($1,'2026-08-05','2026-08-31','CLOSURE','TEST-E2E capacity laboratory',$3),
         ($2,'2026-08-05','2026-08-31','CLOSURE','TEST-E2E capacity physical',$3)`,
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
    const kabalakaClosure = await createClinicUnavailableDate({
      clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
      startDate: laboratoryBefore.appointment_date,
      endDate: laboratoryBefore.appointment_date,
      category: "MAINTENANCE",
      reason: "TEST-E2E KABALAKA closure",
    }, admin);
    expect(kabalakaClosure).toMatchObject({ movedStudentCount: 1, movedAppointmentCount: 2 });
    const activePair = await currentPair();
    expect(activePair.rows).toHaveLength(2);
    expect(activePair.rows.some((row) => row.id === laboratoryBefore.id)).toBe(false);

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
    await expect(getStudentResultFile("99-9003-03", pdf.id, storage))
      .resolves.toMatchObject({ filename: "synthetic-laboratory.pdf" });
    await expect(getStudentResultFile("99-9001-01", pdf.id, storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_NOT_FOUND", status: 404 });
    await expect(getAdminStudentResultFile(pdf.id, admin, storage))
      .resolves.toMatchObject({ filename: "synthetic-laboratory.pdf" });
    const zip = await createAdminSubmissionZip(finalized.id, admin, storage);
    expect(zip.subarray(0, 2).toString("ascii")).toBe("PK");

    await invalidateStudentResultSubmission(finalized.id, "Synthetic document replacement test", admin, storage);
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
  }, 60000);
});
