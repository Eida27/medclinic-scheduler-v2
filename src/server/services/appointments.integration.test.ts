// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { publicStudentSchedule } from "@/server/repositories/appointments.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { addScheduleBatch, generateBatchAppointments } from "./coordinator-schedules.service";
import { publishScheduleBatch, updateAppointment } from "./appointments.service";

const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};
const studentNumber = "TEST-APPT-0001";

beforeAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%");
  await insertTestStudent({
    studentNumber,
    firstName: "Appointment",
    lastName: "Fixture",
    yearLevel: 3,
  });
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-APPT-%", "TEST appointment lifecycle%");
  await pool.end();
});

describe("appointment lifecycle", () => {
  it("hides drafts, publishes them, and creates a logged replacement on reschedule", async () => {
    const batch = await addScheduleBatch({
      batchName: "TEST appointment lifecycle fixture",
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      submittedByName: "Test",
      description: "Disposable",
      items: [{
        studentNumber, scheduleType: "PHYSICAL_EXAM",
        priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
        targetDate: "2026-08-05", targetWeekStart: null, targetWeekEnd: null, remarks: "",
      }],
    }, admin.userId);
    const batchId = String(batch?.id);

    await generateBatchAppointments(batchId, admin);
    expect((await publicStudentSchedule(studentNumber))?.appointments).toHaveLength(0);
    await publishScheduleBatch(batchId, admin.userId);
    expect((await publicStudentSchedule(studentNumber))?.appointments).toHaveLength(1);

    const current = await pool.query<{ id: string }>("SELECT id FROM appointments WHERE batch_id=$1", [batchId]);
    const replacement = await updateAppointment(current.rows[0].id, {
      appointmentDate: "2026-08-06", appointmentTime: "09:00", notes: "Student conflict",
    }, admin.userId);
    expect(replacement?.status).toBe("PENDING");
    expect(replacement?.rescheduledFrom).toBe(current.rows[0].id);
    const logs = await pool.query("SELECT new_status FROM appointment_status_logs WHERE appointment_id IN ($1,$2)", [current.rows[0].id, replacement?.id]);
    expect(logs.rows.map((row) => row.new_status)).toEqual(expect.arrayContaining(["PENDING", "RESCHEDULED"]));
  });
});
