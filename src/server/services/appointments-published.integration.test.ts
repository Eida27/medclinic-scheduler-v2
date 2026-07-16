// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  getPublishedAppointment,
  listAppointments,
  publicStudentSchedule,
} from "@/server/repositories/appointments.repository";
import { studentHistory } from "@/server/repositories/students.repository";
import {
  cleanupTestFixtures,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { updateAppointment } from "./appointments.service";
import {
  generateScheduleImport,
  importStudentScheduleCsv,
  publishScheduleImport,
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

const studentNumber = "TEST-PUB-0001";
const studentPattern = "TEST-PUB-%";
const batchPattern = "TEST published guards%";
const importPattern = "TEST published guards%";
const header = [
  "Student ID",
  "Name",
  "College",
  "Course",
  "Year",
  "Laboratory Schedule",
  "Physical Examination Schedule",
].join(",");

async function cleanup() {
  await cleanupTestFixtures(studentPattern, batchPattern, importPattern);
}

beforeEach(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("published-only appointment access", () => {
  it("hides grouped drafts everywhere normal, then exposes and operates them after publication", async () => {
    const contents = [
      header,
      `${studentNumber},"Santos, Ada Lynne",College of Computer Studies,BSIT,3,02-08-2027,02-09-2027`,
    ].join("\n");
    const created = await importStudentScheduleCsv({
      fileName: "published-guards.csv",
      fileSize: Buffer.byteLength(contents),
      contents,
      importName: "TEST published guards grouped",
      priorityGroupId: TEST_REFERENCE_IDS.regularPriority,
      submittedByName: "Published guards test",
      description: "Disposable grouped appointment visibility fixture",
    }, admin);
    await pool.query(
      "UPDATE students SET suffix='Jr.' WHERE student_number=$1",
      [studentNumber],
    );
    await validateScheduleImport(created.importId, admin);
    await generateScheduleImport(created.importId, admin);

    const generated = await pool.query<{
      id: string;
      schedule_type: string;
      status: string;
      is_published: boolean;
    }>(
      `SELECT id, schedule_type, status, is_published
         FROM appointments
        WHERE batch_id = ANY($1::uuid[])
        ORDER BY schedule_type`,
      [created.batchIds],
    );
    expect(generated.rows).toHaveLength(2);
    expect(generated.rows.every((row) => row.status === "DRAFT" && !row.is_published)).toBe(true);

    const laboratoryDraft = generated.rows.find((row) => row.schedule_type === "LABORATORY");
    expect(laboratoryDraft).toBeDefined();
    await pool.query(
      `INSERT INTO laboratory_results (
         student_number, appointment_id, result_status, completed_at, remarks, encoded_by
       ) VALUES ($1,$2,'COMPLETED','2027-02-08','Legacy draft-linked result',$3)`,
      [studentNumber, laboratoryDraft?.id, admin.userId],
    );

    const draftId = generated.rows[0].id;
    await expect(getPublishedAppointment(draftId)).resolves.toBeNull();
    await expect(updateAppointment(
      draftId,
      {},
      admin,
    )).rejects.toMatchObject({ code: "APPOINTMENT_NOT_FOUND", status: 404 });
    await expect(updateAppointment(
      draftId,
      { status: "PENDING", notes: null },
      admin,
    )).rejects.toMatchObject({ code: "APPOINTMENT_NOT_FOUND", status: 404 });
    expect((await listAppointments({
      studentNumber: "Ada Lynne Santos Jr.",
      isPublished: true,
      page: 1,
      limit: 20,
      offset: 0,
    })).items).toEqual([]);
    expect((await listAppointments({
      studentNumber,
      page: 1,
      limit: 20,
      offset: 0,
    })).items).toEqual([]);
    expect(await studentHistory(studentNumber)).toMatchObject({
      appointments: [],
      laboratoryResults: [],
    });
    expect(await publicStudentSchedule(studentNumber)).toMatchObject({
      appointments: [],
      compliance: { laboratory: "PENDING" },
    });

    await publishScheduleImport(created.importId, admin);

    const byCanonicalName = await listAppointments({
      studentNumber: "Ada Lynne Santos Jr.",
      isPublished: true,
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(byCanonicalName.items).toHaveLength(2);
    expect(byCanonicalName.items.every((item) => item.studentNumber === studentNumber)).toBe(true);
    expect((await listAppointments({
      studentNumber: "PUB-0001",
      isPublished: true,
      page: 1,
      limit: 20,
      offset: 0,
    })).items).toHaveLength(2);
    const publishedHistory = await studentHistory(studentNumber);
    expect(publishedHistory.appointments).toHaveLength(2);
    expect(publishedHistory.laboratoryResults).toEqual([
      expect.objectContaining({ appointment_id: laboratoryDraft?.id }),
    ]);
    expect(await publicStudentSchedule(studentNumber)).toMatchObject({
      appointments: expect.arrayContaining([
        expect.objectContaining({ scheduleType: "LABORATORY" }),
      ]),
      compliance: { laboratory: "COMPLETED" },
    });
    await expect(getPublishedAppointment(draftId)).resolves.toMatchObject({
      id: draftId,
      isPublished: true,
      status: "PENDING",
    });

    const completed = await updateAppointment(
      draftId,
      { status: "COMPLETED", notes: "Completed after grouped publication" },
      admin,
    );
    expect(completed).toMatchObject({ id: draftId, status: "COMPLETED", isPublished: true });
  });
});
