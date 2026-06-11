// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { publicStudentSchedule } from "@/server/repositories/appointments.repository";
import { addScheduleBatch, generateBatchAppointments } from "./coordinator-schedules.service";
import { publishScheduleBatch, updateAppointment } from "./appointments.service";

const admin = {
  userId: "00000000-0000-4000-8000-000000000001",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};

afterAll(async () => pool.end());

describe("appointment lifecycle", () => {
  it("hides drafts, publishes them, and creates a logged replacement on reschedule", async () => {
    const batch = await addScheduleBatch({
      batchName: "Appointment lifecycle fixture",
      collegeId: "10000000-0000-4000-8000-000000000003",
      programId: "20000000-0000-4000-8000-000000000003",
      submittedByName: "Test",
      description: "Disposable",
      items: [{
        studentNumber: "DEMO-0179", scheduleType: "PHYSICAL_EXAM",
        priorityGroupId: "30000000-0000-4000-8000-000000000004",
        targetDate: "2026-08-05", targetWeekStart: null, targetWeekEnd: null, remarks: "",
      }],
    }, admin.userId);
    const batchId = String(batch?.id);

    try {
      await generateBatchAppointments(batchId, admin);
      expect((await publicStudentSchedule("DEMO-0179"))?.appointments).toHaveLength(0);
      await publishScheduleBatch(batchId, admin.userId);
      expect((await publicStudentSchedule("DEMO-0179"))?.appointments).toHaveLength(1);

      const current = await pool.query<{ id: string }>("SELECT id FROM appointments WHERE batch_id=$1", [batchId]);
      const replacement = await updateAppointment(current.rows[0].id, {
        appointmentDate: "2026-08-06", appointmentTime: "09:00", notes: "Student conflict",
      }, admin.userId);
      expect(replacement?.status).toBe("PENDING");
      expect(replacement?.rescheduledFrom).toBe(current.rows[0].id);
      const logs = await pool.query("SELECT new_status FROM appointment_status_logs WHERE appointment_id IN ($1,$2)", [current.rows[0].id, replacement?.id]);
      expect(logs.rows.map((row) => row.new_status)).toEqual(expect.arrayContaining(["PENDING", "RESCHEDULED"]));
    } finally {
      await pool.query("DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM appointments WHERE batch_id=$1)", [batchId]);
      await pool.query("DELETE FROM appointments WHERE batch_id=$1", [batchId]);
      await pool.query("DELETE FROM schedule_batches WHERE id=$1", [batchId]);
    }
  });
});
