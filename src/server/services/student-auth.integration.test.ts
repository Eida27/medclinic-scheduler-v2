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
  it("authenticates an active student with normalized number, DOB, and complete Middle Name", async () => {
    await insertTestStudent({
      studentNumber: "99-9601-01",
      firstName: "Portal",
      middleName: "Maria Angela",
      lastName: "Student",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await expect(authenticateStudent({
      studentNumber: " 99-9601-01 ",
      dateOfBirth: "2003-05-06",
      middleName: "Maria Angela",
      ipAddress: "127.0.0.1",
    })).resolves.toEqual({ studentNumber: "99-9601-01", sessionType: "STUDENT" });
  });

  it("accepts different Middle Name capitalization without changing the session", async () => {
    await insertTestStudent({
      studentNumber: "99-9602-02",
      firstName: "Case",
      middleName: "De la Cruz",
      lastName: "Insensitive",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });

    await expect(authenticateStudent({
      studentNumber: "99-9602-02",
      dateOfBirth: "2003-05-06",
      middleName: "DE LA CRUZ",
      ipAddress: "10.0.0.2",
    })).resolves.toEqual({ studentNumber: "99-9602-02", sessionType: "STUDENT" });
  });

  it("rejects every spacing, punctuation, partial-name, and initials mismatch generically", async () => {
    await insertTestStudent({
      studentNumber: "99-9603-03",
      firstName: "Exact",
      middleName: "De la Cruz",
      lastName: "Match",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    const mismatches = [
      "Dela Cruz",
      "De  la Cruz",
      " De la Cruz",
      "De la Cruz ",
      "De la Cruz.",
      "De",
      "D. L. C.",
    ];

    for (const [index, middleName] of mismatches.entries()) {
      await expect(authenticateStudent({
        studentNumber: "99-9603-03",
        dateOfBirth: "2003-05-06",
        middleName,
        ipAddress: `10.0.1.${index + 1}`,
      })).rejects.toMatchObject({
        code: "INVALID_STUDENT_CREDENTIALS",
        message: "Invalid Student Number, Date of Birth, or Middle Name.",
        status: 401,
      });
    }
  });

  it("uses the generic failure for legacy null names, missing DOB, inactive, unknown, and DOB mismatch", async () => {
    await insertTestStudent({
      studentNumber: "99-9604-04",
      firstName: "Legacy",
      middleName: null,
      lastName: "NoMiddle",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await insertTestStudent({
      studentNumber: "99-9605-05",
      firstName: "Missing",
      middleName: "Maria Angela",
      lastName: "Birthdate",
      yearLevel: 3,
    });
    await insertTestStudent({
      studentNumber: "99-9606-06",
      firstName: "Inactive",
      middleName: "Maria Angela",
      lastName: "Student",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await insertTestStudent({
      studentNumber: "99-9612-12",
      firstName: "Wrong",
      middleName: "Maria Angela",
      lastName: "Birthdate",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await pool.query("UPDATE students SET is_active=FALSE WHERE student_number='99-9606-06'");
    for (const [studentNumber, dateOfBirth, middleName, ipAddress] of [
      ["99-9604-04", "2003-05-06", "Maria Angela", "10.0.2.1"],
      ["99-9605-05", "2003-05-06", "Maria Angela", "10.0.2.2"],
      ["99-9606-06", "2003-05-06", "Maria Angela", "10.0.2.3"],
      ["99-9699-99", "2003-05-06", "Maria Angela", "10.0.2.4"],
      ["99-9612-12", "2000-01-01", "Maria Angela", "10.0.2.5"],
    ]) {
      await expect(authenticateStudent({ studentNumber, dateOfBirth, middleName, ipAddress }))
        .rejects.toMatchObject({
          code: "INVALID_STUDENT_CREDENTIALS",
          message: "Invalid Student Number, Date of Birth, or Middle Name.",
          status: 401,
        });
    }
  });

  it("rejects missing, blank, whitespace-only, and oversized Middle Names before recording attempts", async () => {
    await insertTestStudent({
      studentNumber: "99-9607-07",
      firstName: "Validation",
      middleName: "Maria Angela",
      lastName: "Boundary",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    const invalidValues = [undefined, "", "   ", "M".repeat(101)];

    for (const [index, middleName] of invalidValues.entries()) {
      const input = {
        studentNumber: "99-9607-07",
        dateOfBirth: "2003-05-06",
        middleName,
        ipAddress: `10.0.3.${index + 1}`,
      } as Parameters<typeof authenticateStudent>[0];
      await expect(authenticateStudent(input)).rejects.toMatchObject({ name: "ZodError" });
    }

    const attempts = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM student_login_attempts WHERE student_number='99-9607-07'",
    );
    expect(attempts.rows).toEqual([{ count: 0 }]);
  });

  it("counts incorrect Middle Names and locks the normalized Student Number/IP pair on failure five", async () => {
    await insertTestStudent({
      studentNumber: "99-9608-08",
      firstName: "Rate",
      middleName: "Maria Angela",
      lastName: "Limited",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(authenticateStudent({
        studentNumber: "99-9608-08",
        dateOfBirth: "2003-05-06",
        middleName: "Wrong Name",
        ipAddress: "10.0.4.1",
      })).rejects.toMatchObject({ code: "INVALID_STUDENT_CREDENTIALS", status: 401 });
    }
    await expect(authenticateStudent({
      studentNumber: "99-9608-08",
      dateOfBirth: "2003-05-06",
      middleName: "Wrong Name",
      ipAddress: "10.0.4.1",
    })).rejects.toMatchObject({ code: "STUDENT_LOGIN_THROTTLED", status: 429 });
    const attempt = await pool.query<{ failed_count: number; lock_minutes: number }>(
      `SELECT failed_count,
              FLOOR(EXTRACT(EPOCH FROM (locked_until - last_failed_at)) / 60)::int AS lock_minutes
         FROM student_login_attempts
        WHERE student_number='99-9608-08' AND ip_address='10.0.4.1'`,
    );
    expect(attempt.rows).toEqual([{ failed_count: 5, lock_minutes: 15 }]);
  });

  it("clears the existing attempt row after a successful sign-in", async () => {
    await insertTestStudent({
      studentNumber: "99-9609-09",
      firstName: "Clear",
      middleName: "Maria Angela",
      lastName: "Attempts",
      yearLevel: 3,
      dateOfBirth: "2003-05-06",
    });
    await expect(authenticateStudent({
      studentNumber: "99-9609-09",
      dateOfBirth: "2003-05-06",
      middleName: "Wrong Name",
      ipAddress: "10.0.5.1",
    })).rejects.toMatchObject({ code: "INVALID_STUDENT_CREDENTIALS" });

    await expect(authenticateStudent({
      studentNumber: "99-9609-09",
      dateOfBirth: "2003-05-06",
      middleName: "maria angela",
      ipAddress: "10.0.5.1",
    })).resolves.toEqual({ studentNumber: "99-9609-09", sessionType: "STUDENT" });
    const attempts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM student_login_attempts
        WHERE student_number='99-9609-09' AND ip_address='10.0.5.1'`,
    );
    expect(attempts.rows).toEqual([{ count: 0 }]);
  });

  it("returns only the authenticated student's published schedule and history", async () => {
    for (const [studentNumber, firstName] of [["99-9610-10", "Owner"], ["99-9611-11", "Other"]]) {
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
    const portal = await getStudentPortalSchedule("99-9610-10");
    expect(portal).not.toBeNull();
    if (!portal) throw new Error("Expected a portal schedule for the fixture student");
    expect(portal.studentNumber).toBe("99-9610-10");
    expect(portal.appointments).toEqual([
      expect.objectContaining({ studentNumber: "99-9610-10", appointmentDate: "2027-08-02" }),
    ]);
    expect(JSON.stringify(portal)).not.toContain("99-9611-11");
  });
});
