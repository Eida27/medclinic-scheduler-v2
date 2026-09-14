// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { authenticateStudent } from "./student-auth.service";
import { createStudent, updateStudent } from "./students.service";

const studentNumber = "99-9701-01";

async function cleanup() {
  await cleanupTestFixtures("99-97%", "TEST-STUDENT-IDENTITY%");
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("manual student identity writes", () => {
  it("creates and edits a trimmed middle name that remains usable for login", async () => {
    await createStudent({
      studentNumber,
      firstName: "Ana",
      middleName: " Maria Angela ",
      lastName: "Santos",
      suffix: null,
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      yearLevel: 2,
      section: "B",
      dateOfBirth: "2004-08-04",
    }, TEST_REFERENCE_IDS.adminUser);

    await expect(authenticateStudent({
      studentNumber,
      dateOfBirth: "2004-08-04",
      middleName: "maria angela",
      ipAddress: "127.0.0.1",
    })).resolves.toEqual({ studentNumber, sessionType: "STUDENT" });

    await updateStudent(studentNumber, {
      firstName: "Ana",
      middleName: " Rosa Elena ",
      lastName: "Santos",
      suffix: null,
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      yearLevel: 2,
      section: "B",
      dateOfBirth: "2004-08-04",
    }, TEST_REFERENCE_IDS.adminUser);

    await expect(authenticateStudent({
      studentNumber,
      dateOfBirth: "2004-08-04",
      middleName: "ROSA ELENA",
      ipAddress: "127.0.0.2",
    })).resolves.toEqual({ studentNumber, sessionType: "STUDENT" });
  });

  it.each([
    ["null", null],
    ["omitted", undefined],
    ["whitespace-only", "   "],
  ])("rejects a %s middle-name edit before changing stored credentials", async (_label, middleName) => {
    await createStudent({
      studentNumber,
      firstName: "Ana",
      middleName: "Original Middle",
      lastName: "Santos",
      suffix: null,
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      yearLevel: 2,
      section: "B",
      dateOfBirth: "2004-08-04",
    }, TEST_REFERENCE_IDS.adminUser);
    const input: Record<string, unknown> = {
      firstName: "Changed",
      lastName: "Santos",
      suffix: null,
      collegeId: TEST_REFERENCE_IDS.college,
      programId: TEST_REFERENCE_IDS.program,
      yearLevel: 2,
      section: "B",
      dateOfBirth: "2004-08-04",
    };
    if (middleName !== undefined) input.middleName = middleName;

    await expect(updateStudent(
      studentNumber,
      input,
      TEST_REFERENCE_IDS.adminUser,
    )).rejects.toMatchObject({ name: "ZodError" });

    const stored = await pool.query<{
      first_name: string;
      middle_name: string | null;
      date_of_birth: string;
    }>(
      `SELECT first_name, middle_name, date_of_birth::text
         FROM students
        WHERE student_number=$1`,
      [studentNumber],
    );
    expect(stored.rows).toEqual([{
      first_name: "Ana",
      middle_name: "Original Middle",
      date_of_birth: "2004-08-04",
    }]);
  });
});
