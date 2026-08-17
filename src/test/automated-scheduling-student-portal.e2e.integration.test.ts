// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { publicStudentSchedule } from "@/server/repositories/appointments.repository";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import { saveClinicCalendarChanges } from "@/server/services/clinic-calendar.service";
import { acceptAndScheduleImport } from "@/server/services/schedule-imports.service";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import type { SessionUser } from "@/types/roles";

const studentNumber = "99-9801-01";
let capacityFixture: CapacityFixtureLock | null = null;
let academicYearOwnedByFixture = false;
const academicYearStart = 2050;
const academicYearClosingDate = "2051-07-31";
const importPattern = "REGULAR % - TEST-UNIFIED-E2E%";
const requestIds = [
  "98000000-0000-4000-8000-000000000001",
  "98000000-0000-4000-8000-000000000002",
  "98000000-0000-4000-8000-000000000003",
  "98000000-0000-4000-8000-000000000004",
];
const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

async function cleanup() {
  await cleanupTestFixtures("99-98%", importPattern, importPattern);
  await pool.query("DELETE FROM clinic_calendar_requests WHERE request_id=ANY($1::uuid[])", [requestIds]);
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE 'TEST-UNIFIED-E2E%')`,
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'TEST-UNIFIED-E2E%'");
  await pool.query("DELETE FROM audit_logs WHERE metadata->>'requestId'=ANY($1::text[])", [requestIds]);
  if (!academicYearOwnedByFixture) return;
  const deleted = await pool.query<{ start_year: number }>(
    `DELETE FROM academic_years
      WHERE start_year=$1
        AND closing_date=$2
        AND created_by=$3
        AND updated_by=$3
      RETURNING start_year`,
    [academicYearStart, academicYearClosingDate, TEST_REFERENCE_IDS.adminUser],
  );
  if (deleted.rows.length !== 1) {
    throw new Error("Fixture-owned academic year is missing or changed");
  }
  academicYearOwnedByFixture = false;
}

async function configureAcademicYear() {
  const collision = await pool.query(
    "SELECT start_year FROM academic_years WHERE start_year=$1",
    [academicYearStart],
  );
  if (collision.rows.length) {
    throw new Error(`Academic year ${academicYearStart} already exists; refusing to claim it`);
  }

  const inserted = await pool.query<{ start_year: number }>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,$2,$3,$3)
     RETURNING start_year`,
    [academicYearStart, academicYearClosingDate, TEST_REFERENCE_IDS.adminUser],
  );
  academicYearOwnedByFixture = true;
  if (inserted.rows.length !== 1) {
    throw new Error("Academic-year fixture insert did not return its owned row");
  }
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, cleanup);
});
beforeEach(configureAcademicYear);
afterEach(async () => {
  if (!capacityFixture) return;
  await cleanupAndRestoreCapacitySettings(pool, capacityFixture.originalCapacities, cleanup);
});
afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, cleanup);
});

describe("unified calendar scheduling and student flow", () => {
  it("does not let fixture cleanup claim a preexisting academic year", async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
       VALUES ($1,$2,$3,$3)`,
      [academicYearStart, academicYearClosingDate, TEST_REFERENCE_IDS.adminUser],
    );

    try {
      await expect(configureAcademicYear()).rejects.toThrow(
        `Academic year ${academicYearStart} already exists; refusing to claim it`,
      );
      await cleanup();
      const existing = await pool.query<{ start_year: number }>(
        "SELECT start_year FROM academic_years WHERE start_year=$1",
        [academicYearStart],
      );
      expect(existing.rows).toEqual([{ start_year: academicYearStart }]);
    } finally {
      await pool.query(
        `DELETE FROM academic_years
          WHERE start_year=$1
            AND closing_date=$2
            AND created_by=$3
            AND updated_by=$3`,
        [academicYearStart, academicYearClosingDate, TEST_REFERENCE_IDS.adminUser],
      );
    }
  });

  it("avoids a pre-import block, reschedules current appointments, and restores only after final reopening", async () => {
    await saveClinicCalendarChanges({
      requestId: requestIds[0],
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "BLOCK", date: "2050-08-01", category: "CLOSURE", reason: "TEST-UNIFIED-E2E pre-import" }],
    }, admin);
    await acceptAndScheduleImport({
      fileName: "TEST-UNIFIED-E2E.csv",
      fileSize: 100,
      contents: [
        "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
        `${studentNumber},Calendar,Unified,Maria Angela,,College of Computer Studies,BSIT,3,2003-05-06`,
      ].join("\n"),
      studentCategory: "REGULAR",
      academicYearStart,
      preferredMonth: null,
    }, admin);
    const imported = await pool.query<{ schedule_type: string; appointment_date: string }>(
      `SELECT schedule_type,appointment_date::text FROM appointments
        WHERE student_number=$1 AND status='PENDING' ORDER BY schedule_type`,
      [studentNumber],
    );
    expect(imported.rows).toEqual([
      { schedule_type: "LABORATORY", appointment_date: "2050-08-02" },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2050-08-03" },
    ]);

    const moved = await saveClinicCalendarChanges({
      requestId: requestIds[1],
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [
        { action: "BLOCK", date: "2050-08-02", category: "CLOSURE", reason: "TEST-UNIFIED-E2E current pair" },
        { action: "BLOCK", date: "2050-08-03", category: "CLOSURE", reason: "TEST-UNIFIED-E2E current pair" },
      ],
    }, admin);
    expect(moved).toMatchObject({ movedStudentCount: 1, movedAppointmentCount: 2 });
    const publicSchedule = await publicStudentSchedule(studentNumber);
    expect(publicSchedule).toMatchObject({
      studentNumber,
      appointments: [
        expect.objectContaining({ appointmentDate: "2050-08-04", status: "PENDING" }),
        expect.objectContaining({ appointmentDate: "2050-08-05", status: "PENDING" }),
      ],
    });
    expect(JSON.stringify(publicSchedule)).not.toContain("2050-08-02");
    const portal = await getStudentPortalSchedule(studentNumber);
    expect(portal?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ originalDate: "2050-08-02", closureReason: "TEST-UNIFIED-E2E current pair" }),
      expect.objectContaining({ originalDate: "2050-08-03", closureReason: "TEST-UNIFIED-E2E current pair" }),
    ]));

    const first = moved.activeUnavailableDates.find((date) => date.blockedDate === "2050-08-02")!;
    const second = moved.activeUnavailableDates.find((date) => date.blockedDate === "2050-08-03")!;
    await saveClinicCalendarChanges({
      requestId: requestIds[2],
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "REOPEN", date: first.blockedDate, unavailableDateId: first.id, expectedUpdatedAt: first.updatedAt }],
    }, admin);
    const reopened = await saveClinicCalendarChanges({
      requestId: requestIds[3],
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{ action: "REOPEN", date: second.blockedDate, unavailableDateId: second.id, expectedUpdatedAt: second.updatedAt }],
    }, admin);
    expect(reopened).toMatchObject({ reopenedDateCount: 1, movedAppointmentCount: 0 });
    await expect(publicStudentSchedule(studentNumber)).resolves.toMatchObject({
      appointments: [
        expect.objectContaining({ appointmentDate: "2050-08-04", status: "PENDING" }),
        expect.objectContaining({ appointmentDate: "2050-08-05", status: "PENDING" }),
      ],
    });
  });
});
