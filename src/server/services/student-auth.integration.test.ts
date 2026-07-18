// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import { authenticateStudent } from "./student-auth.service";

const studentPattern = "99-96%";

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-STUDENT-PORTAL%", "TEST-STUDENT-PORTAL%");
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("student authentication", () => {
  it("authenticates an active student by normalized number and DOB", async () => {
    await insertTestStudent({
      studentNumber: "99-9601-01",
      firstName: "Portal",
      lastName: "Student",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await expect(authenticateStudent({
      studentNumber: " 99-9601-01 ",
      dateOfBirth: "2003-05-06",
      ipAddress: "127.0.0.1",
    })).resolves.toEqual({ studentNumber: "99-9601-01", sessionType: "STUDENT" });
  });

  it("uses generic failures for missing DOB, inactive, and mismatched credentials", async () => {
    await insertTestStudent({
      studentNumber: "99-9602-02",
      firstName: "Missing",
      lastName: "Birthdate",
      yearLevel: 3,
    });
    await insertTestStudent({
      studentNumber: "99-9603-03",
      firstName: "Inactive",
      lastName: "Student",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await pool.query("UPDATE students SET is_active=FALSE WHERE student_number='99-9603-03'");
    for (const [studentNumber, dateOfBirth, ipAddress] of [
      ["99-9602-02", "2003-05-06", "10.0.0.2"],
      ["99-9603-03", "2003-05-06", "10.0.0.3"],
      ["99-9699-99", "2003-05-06", "10.0.0.4"],
    ]) {
      await expect(authenticateStudent({ studentNumber, dateOfBirth, ipAddress }))
        .rejects.toMatchObject({
          code: "INVALID_STUDENT_CREDENTIALS",
          message: "Invalid Student Number or Date of Birth.",
          status: 401,
        });
    }
  });

  it("locks a normalized Student Number and IP pair for 15 minutes after five failures", async () => {
    await insertTestStudent({
      studentNumber: "99-9604-04",
      firstName: "Rate",
      lastName: "Limited",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(authenticateStudent({
        studentNumber: "99-9604-04",
        dateOfBirth: "2000-01-01",
        ipAddress: "10.0.0.5",
      })).rejects.toMatchObject({ code: "INVALID_STUDENT_CREDENTIALS", status: 401 });
    }
    await expect(authenticateStudent({
      studentNumber: "99-9604-04",
      dateOfBirth: "2000-01-01",
      ipAddress: "10.0.0.5",
    })).rejects.toMatchObject({ code: "STUDENT_LOGIN_THROTTLED", status: 429 });
    const attempt = await pool.query<{ failed_count: number; lock_minutes: number }>(
      `SELECT failed_count,
              FLOOR(EXTRACT(EPOCH FROM (locked_until - last_failed_at)) / 60)::int AS lock_minutes
         FROM student_login_attempts
        WHERE student_number='99-9604-04' AND ip_address='10.0.0.5'`,
    );
    expect(attempt.rows).toEqual([{ failed_count: 5, lock_minutes: 15 }]);
  });

  it("returns only the authenticated student's published schedule and history", async () => {
    for (const [studentNumber, firstName] of [["99-9605-05", "Owner"], ["99-9606-06", "Other"]]) {
      await insertTestStudent({
        studentNumber,
        firstName,
        lastName: "Portal",
        yearLevel: 3,
        dateOfBirth: "2003-05-06",
      });
      await pool.query(
        `INSERT INTO appointments (
           clinic_id, student_number, schedule_type, appointment_date,
           status, is_published, created_by
         ) VALUES ($1,$2,'LABORATORY','2027-08-02','PENDING',TRUE,$3)`,
        [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, TEST_REFERENCE_IDS.adminUser],
      );
    }
    const portal = await getStudentPortalSchedule("99-9605-05");
    expect(portal).not.toBeNull();
    if (!portal) throw new Error("Expected a portal schedule for the fixture student");
    expect(portal.studentNumber).toBe("99-9605-05");
    expect(portal.appointments).toEqual([
      expect.objectContaining({ studentNumber: "99-9605-05", appointmentDate: "2027-08-02" }),
    ]);
    expect(JSON.stringify(portal)).not.toContain("99-9606-06");
  });
});
