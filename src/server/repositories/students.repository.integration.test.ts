// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { getStudent, listStudents } from "./students.repository";

const studentPattern = "TEST-NAME-FORMAT-%";

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST name format%");
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO students (
       student_number, first_name, middle_name, last_name, suffix,
       college_id, program_id, year_level
     ) VALUES
       ('TEST-NAME-FORMAT-001','Ana','Maria Angela','Santos','Jr.',$1,$2,4),
       ('TEST-NAME-FORMAT-002','Ana','L.','Santos',NULL,$1,$2,4),
       ('TEST-NAME-FORMAT-003','Ana',NULL,'Santos','III',$1,$2,4),
       ('TEST-NAME-FORMAT-004','  Ana  ','  maria  ','  Santos  ','  Jr.  ',$1,$2,4),
       ('TEST-NAME-FORMAT-005','Ana',NULL,'Santos',NULL,$1,$2,4)`,
    [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program],
  );
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("student display names", () => {
  it.each([
    ["TEST-NAME-FORMAT-001", "Santos, Ana M. (Jr.)"],
    ["TEST-NAME-FORMAT-002", "Santos, Ana L."],
    ["TEST-NAME-FORMAT-003", "Santos, Ana (III)"],
    ["TEST-NAME-FORMAT-004", "Santos, Ana M. (Jr.)"],
    ["TEST-NAME-FORMAT-005", "Santos, Ana"],
  ])("formats %s from its stored name parts", async (studentNumber, expected) => {
    await expect(getStudent(studentNumber)).resolves.toMatchObject({
      studentNumber,
      fullName: expected,
    });
  });

  it.each(["Santos, Ana", "Ana Santos"])(
    "finds the middle-name fixture using the %s search order",
    async (search) => {
      const result = await listStudents({
        search,
        page: 1,
        limit: 20,
        offset: 0,
      });

      expect(result.items.map((student) => student.studentNumber)).toContain(
        "TEST-NAME-FORMAT-001",
      );
    },
  );
});
