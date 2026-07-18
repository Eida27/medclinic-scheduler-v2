// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { acceptAndScheduleImport, getScheduleImport } from "./schedule-imports.service";

const studentPattern = "99-93%";
const importPattern = "REGULAR 2026-2027 - TEST-DETAIL%";
const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
};

async function cleanup() {
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("published schedule import detail", () => {
  it("returns compact published children with nullable category-driven priority", async () => {
    const contents = [
      "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth",
      "99-9301-01,Reviewer,Draft,M.,,College of Computer Studies,BSIT,3,05-06-2003",
    ].join("\n");
    const created = await acceptAndScheduleImport({
      fileName: "TEST-DETAIL-students.csv",
      fileSize: Buffer.byteLength(contents),
      contents,
      studentCategory: "REGULAR",
      academicYearStart: 2026,
      preferredMonth: null,
    }, admin);

    const detail = await getScheduleImport(created.importId, admin);
    expect(detail.status).toBe("PUBLISHED");
    expect(detail.childBatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clinicCode: "KABALAKA_CLINIC",
        status: "PUBLISHED",
        items: [expect.objectContaining({
          studentNumber: "99-9301-01",
          studentName: "Reviewer, Draft M.",
          priorityGroupId: null,
          priorityGroupName: null,
        })],
        appointments: [expect.objectContaining({
          studentNumber: "99-9301-01",
          studentName: "Reviewer, Draft M.",
          scheduleType: "LABORATORY",
          priorityGroupName: null,
          status: "PENDING",
          isPublished: true,
        })],
      }),
      expect.objectContaining({
        clinicCode: "CPU_CLINIC",
        status: "PUBLISHED",
        items: [expect.objectContaining({ scheduleType: "PHYSICAL_EXAM" })],
      }),
    ]));
  });
});
