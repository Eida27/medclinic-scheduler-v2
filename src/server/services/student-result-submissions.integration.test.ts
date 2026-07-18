// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { LocalResultStorage } from "@/server/storage/local-result-storage";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  addStudentResultFile,
  getStudentResultSubmission,
  removeStudentResultFile,
} from "./student-result-submissions.service";

const studentPattern = "99-94%";
let storageRoot = "";
let storage: LocalResultStorage;

async function cleanup() {
  await cleanupTestFixtures(studentPattern, "TEST-RESULT-DRAFT%", "TEST-RESULT-DRAFT%");
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true });
    storageRoot = await mkdtemp(join(tmpdir(), "medclinic-result-drafts-"));
    storage = new LocalResultStorage(storageRoot);
  }
}

async function appointment(studentNumber: string, status: "PENDING" | "COMPLETED" = "COMPLETED") {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by
     ) VALUES ($1,$2,'LABORATORY','2027-08-02',$3,TRUE,$4)
     RETURNING id`,
    [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, status, TEST_REFERENCE_IDS.adminUser],
  );
  return result.rows[0].id;
}

function file(filename = "result.pdf", body = "%PDF-1.7\nsynthetic result") {
  return { filename, declaredMimeType: "application/pdf", bytes: Buffer.from(body) };
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "medclinic-result-drafts-"));
  storage = new LocalResultStorage(storageRoot);
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanupTestFixtures(studentPattern, "TEST-RESULT-DRAFT%", "TEST-RESULT-DRAFT%");
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

describe("student result drafts", () => {
  it("resumes a draft, adds/removes files, and never uses original names in storage keys", async () => {
    await insertTestStudent({ studentNumber: "99-9401-01", firstName: "Draft", lastName: "Owner", yearLevel: 3 });
    const appointmentId = await appointment("99-9401-01");
    const added = await addStudentResultFile("99-9401-01", appointmentId, file("My Medical Result.pdf"), storage);
    expect(added.storageKey).toMatch(new RegExp(`^${added.submissionId}/[0-9a-f-]+\\.pdf$`));
    expect(added.storageKey).not.toContain("My Medical Result");
    const resumed = await getStudentResultSubmission("99-9401-01", appointmentId);
    expect(resumed).toMatchObject({ status: "DRAFT", fileCount: 1, totalBytes: file().bytes.byteLength });
    expect(resumed.files[0]).toMatchObject({ originalFilename: "My Medical Result.pdf" });
    await removeStudentResultFile("99-9401-01", appointmentId, added.id, storage);
    expect((await getStudentResultSubmission("99-9401-01", appointmentId)).files).toEqual([]);
  });

  it("requires an owned, published, completed matching appointment before writing storage", async () => {
    for (const studentNumber of ["99-9402-02", "99-9403-03"]) {
      await insertTestStudent({ studentNumber, firstName: "Access", lastName: "Student", yearLevel: 3 });
    }
    const pendingId = await appointment("99-9402-02", "PENDING");
    const completedId = await appointment("99-9402-02", "COMPLETED");
    await expect(addStudentResultFile("99-9402-02", pendingId, file(), storage))
      .rejects.toMatchObject({ code: "RESULT_UPLOAD_NOT_AVAILABLE", status: 409 });
    await expect(addStudentResultFile("99-9403-03", completedId, file(), storage))
      .rejects.toMatchObject({ code: "RESULT_APPOINTMENT_NOT_FOUND", status: 404 });
    expect(await readdir(storageRoot)).toEqual([]);
  });

  it("enforces ten files and 50 MB aggregate limits while leaving rejected bytes unwritten", async () => {
    await insertTestStudent({ studentNumber: "99-9404-04", firstName: "Limit", lastName: "Student", yearLevel: 3 });
    const appointmentId = await appointment("99-9404-04");
    for (let index = 0; index < 10; index += 1) {
      await addStudentResultFile("99-9404-04", appointmentId, file(`result-${index}.pdf`), storage);
    }
    await expect(addStudentResultFile("99-9404-04", appointmentId, file("eleven.pdf"), storage))
      .rejects.toMatchObject({ code: "RESULT_FILE_COUNT_LIMIT", status: 422 });
    expect((await getStudentResultSubmission("99-9404-04", appointmentId)).fileCount).toBe(10);

    await insertTestStudent({ studentNumber: "99-9405-05", firstName: "Total", lastName: "Student", yearLevel: 3 });
    const totalAppointmentId = await appointment("99-9405-05");
    const large = (name: string) => file(name, `%PDF-${"x".repeat(18 * 1024 * 1024)}`);
    await addStudentResultFile("99-9405-05", totalAppointmentId, large("one.pdf"), storage);
    await addStudentResultFile("99-9405-05", totalAppointmentId, large("two.pdf"), storage);
    await expect(addStudentResultFile("99-9405-05", totalAppointmentId, large("three.pdf"), storage))
      .rejects.toMatchObject({ code: "RESULT_TOTAL_SIZE_LIMIT", status: 422 });
    expect((await getStudentResultSubmission("99-9405-05", totalAppointmentId)).fileCount).toBe(2);
  }, 30000);
});
