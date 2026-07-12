// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { listScheduleBatches } from "@/server/repositories/coordinator-schedules.repository";
import { importStudentScheduleCsv } from "@/server/services/schedule-imports.service";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";

const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
} satisfies SessionUser;

const studentPattern = "TEST-LEGACY-%";
const batchPattern = "TEST Legacy%";
const importPattern = "TEST Legacy%";

async function cleanup() {
  await cleanupTestFixtures(studentPattern, batchPattern, importPattern);
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});
describe("legacy coordinator schedule reads", () => {
  it("lists historical ungrouped batches without exposing grouped import children", async () => {
    const contents = [
      "Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule",
      'TEST-LEGACY-001,"Reader, Grouped",College of Computer Studies,BSIT,3,12-14-2026,12-15-2026',
    ].join("\n");
    const grouped = await importStudentScheduleCsv({
      fileName: "TEST-LEGACY-grouped.csv",
      fileSize: Buffer.byteLength(contents),
      contents,
      importName: "TEST Legacy grouped import",
      priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
      submittedByName: "Legacy Test",
      description: null,
    }, admin);
    const ungrouped = await pool.query<{ id: string }>(
      `INSERT INTO schedule_batches (clinic_id, batch_name, created_by)
       VALUES ($1,'TEST Legacy historical batch',$2) RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, admin.userId],
    );

    const listed = await listScheduleBatches();
    expect(listed.map((batch) => batch.id)).toContain(ungrouped.rows[0].id);
    expect(listed.map((batch) => batch.id)).not.toEqual(
      expect.arrayContaining(grouped.batchIds),
    );
  });
});
