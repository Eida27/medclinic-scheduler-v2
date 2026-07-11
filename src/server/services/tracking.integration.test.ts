// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { complianceReport, resultsForStudent } from "@/server/repositories/tracking.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { recordResult, resultSchema } from "./tracking.service";

const actorUserId = TEST_REFERENCE_IDS.clinicStaffUser;
const studentNumber = "TEST-TRACK-0001";

beforeAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await insertTestStudent({
    studentNumber,
    firstName: "Tracking",
    lastName: "Fixture",
    yearLevel: 2,
  });
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-TRACK-%", "TEST tracking fixture%");
  await pool.end();
});

describe("results and compliance", () => {
  it("requires a completion date for completed results", () => {
    expect(() => resultSchema.parse({
      studentNumber, resultType: "PHYSICAL_EXAM",
      resultStatus: "COMPLETED", completedAt: "", remarks: "",
    })).toThrow();
  });

  it("stores historical results and reflects them in compliance", async () => {
    const result = await recordResult({
      studentNumber, appointmentId: null, resultType: "PHYSICAL_EXAM",
      resultStatus: "COMPLETED", completedAt: "2026-07-01", remarks: "Historical record",
    }, actorUserId);
    try {
      const history = await resultsForStudent(studentNumber);
      expect(history?.examResults[0]).toMatchObject({ resultStatus: "COMPLETED", completedAt: "2026-07-01" });
      const compliance = await complianceReport({ search: studentNumber, page: 1, limit: 20, offset: 0 });
      expect(compliance.items[0]).toMatchObject({ physicalExamStatus: "COMPLETED" });
    } finally {
      await pool.query("DELETE FROM exam_results WHERE id=$1", [result.id]);
    }
  });
});
