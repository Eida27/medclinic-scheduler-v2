// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

describe("unified calendar scheduling and student flow", () => {
  it("avoids a pre-import block, reschedules current appointments, and restores only after final reopening", async () => {
    await saveClinicCalendarChanges({
      requestId: requestIds[0],
      emergencyAcknowledged: false,
      changes: [{ action: "BLOCK", date: "2050-08-01", category: "CLOSURE", reason: "TEST-UNIFIED-E2E pre-import" }],
    }, admin);
    await acceptAndScheduleImport({
      fileName: "TEST-UNIFIED-E2E.csv",
      fileSize: 100,
      contents: [
        "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
        `${studentNumber},Calendar,Unified,,,College of Computer Studies,BSIT,4,05-06-2003`,
      ].join("\n"),
      studentCategory: "REGULAR",
      academicYearStart: 2050,
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
    const partial = await saveClinicCalendarChanges({
      requestId: requestIds[2],
      emergencyAcknowledged: false,
      changes: [{ action: "REOPEN", date: first.blockedDate, unavailableDateId: first.id, expectedUpdatedAt: first.updatedAt }],
    }, admin);
    expect(partial.restoredAppointmentCount).toBe(0);
    const restored = await saveClinicCalendarChanges({
      requestId: requestIds[3],
      emergencyAcknowledged: false,
      changes: [{ action: "REOPEN", date: second.blockedDate, unavailableDateId: second.id, expectedUpdatedAt: second.updatedAt }],
    }, admin);
    expect(restored).toMatchObject({ restoredStudentCount: 1, restoredAppointmentCount: 2 });
    await expect(publicStudentSchedule(studentNumber)).resolves.toMatchObject({
      appointments: [
        expect.objectContaining({ appointmentDate: "2050-08-02", status: "PENDING" }),
        expect.objectContaining({ appointmentDate: "2050-08-03", status: "PENDING" }),
      ],
    });
  });
});
