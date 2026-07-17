// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import {
  generateScheduleImport,
  getScheduleImport,
  importStudentScheduleCsv,
  validateScheduleImport,
} from "./schedule-imports.service";

const admin = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
} satisfies SessionUser;

const studentPattern = "TEST-DETAIL-%";
const batchPattern = "TEST Detail%";
const importPattern = "TEST Detail%";

async function cleanup() {
  await cleanupTestFixtures(studentPattern, batchPattern, importPattern);
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("grouped schedule import detail", () => {
  it("returns unpublished draft appointments inside their grouped child batches", async () => {
    const contents = [
      "Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule",
      'TEST-DETAIL-001,"Reviewer, Draft",College of Computer Studies,BSIT,3,12-10-2026,12-11-2026',
    ].join("\n");
    const created = await importStudentScheduleCsv({
      fileName: "TEST-DETAIL-schedule.csv",
      fileSize: Buffer.byteLength(contents),
      contents,
      importName: "TEST Detail appointments",
      priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
      submittedByName: "Test Registrar",
      description: "Disposable grouped detail fixture",
    }, admin);

    await validateScheduleImport(created.importId, admin);
    await generateScheduleImport(created.importId, admin);

    const detail = await getScheduleImport(created.importId, admin);
    expect(detail.childBatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clinicCode: "KABALAKA_CLINIC",
        items: [expect.objectContaining({
          studentNumber: "TEST-DETAIL-001",
          studentName: "Reviewer, Draft",
        })],
        appointments: [expect.objectContaining({
          studentNumber: "TEST-DETAIL-001",
          studentName: "Reviewer, Draft",
          scheduleType: "LABORATORY",
          priorityGroupName: "Regular",
          appointmentDate: "2026-12-10",
          status: "DRAFT",
          isPublished: false,
        })],
      }),
      expect.objectContaining({
        clinicCode: "CPU_CLINIC",
        items: [expect.objectContaining({
          studentNumber: "TEST-DETAIL-001",
          studentName: "Reviewer, Draft",
        })],
        appointments: [expect.objectContaining({
          studentNumber: "TEST-DETAIL-001",
          studentName: "Reviewer, Draft",
          scheduleType: "PHYSICAL_EXAM",
          priorityGroupName: "Regular",
          appointmentDate: "2026-12-11",
          status: "DRAFT",
          isPublished: false,
        })],
      }),
    ]));
  });
});
