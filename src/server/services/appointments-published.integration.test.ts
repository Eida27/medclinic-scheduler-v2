// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  getPublishedAppointment,
  listAppointments,
} from "@/server/repositories/appointments.repository";
import { studentHistory } from "@/server/repositories/students.repository";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";
import {
  cleanupTestFixtures,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { publishScheduleBatch, updateAppointment } from "./appointments.service";

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
  it("projects the active paired Laboratory status without affecting filtered Physical Exam totals", async () => {
    const pairedStudent = "TEST-PUB-PAIR-0001";
    await insertTestStudent({
      studentNumber: pairedStudent,
      firstName: "Paired",
      lastName: "Student",
      yearLevel: 4,
    });
    await pool.query(
      `INSERT INTO appointments (
         id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,rescheduled_from,created_by,updated_by,created_at
       ) VALUES
         ('10000000-0000-4000-8000-000000000001',$2,$1,'PHYSICAL_EXAM','2035-08-10','COMPLETED',TRUE,'30000000-0000-4000-8000-000000000001',2035,NULL,$3,$3,'2035-01-01T00:00:00Z'),
         ('10000000-0000-4000-8000-000000000002',$2,$1,'PHYSICAL_EXAM','2035-08-11','COMPLETED',TRUE,'30000000-0000-4000-8000-000000000002',2035,NULL,$3,$3,'2035-01-01T00:00:00Z'),
         ('10000000-0000-4000-8000-000000000003',$2,$1,'PHYSICAL_EXAM','2035-08-12','NO_SHOW',TRUE,NULL,2035,NULL,$3,$3,'2035-01-01T00:00:00Z'),
         ('10000000-0000-4000-8000-000000000004',$2,$1,'PHYSICAL_EXAM','2035-08-13','PENDING',TRUE,'30000000-0000-4000-8000-000000000003',2035,NULL,$3,$3,'2035-01-01T00:00:00Z'),
         ('20000000-0000-4000-8000-000000000001',$4,$1,'LABORATORY','2035-08-01','PENDING',TRUE,'30000000-0000-4000-8000-000000000001',2035,NULL,$3,$3,'2035-01-01T00:00:00Z'),
         ('20000000-0000-4000-8000-000000000002',$4,$1,'LABORATORY','2035-08-02','NO_SHOW',TRUE,'30000000-0000-4000-8000-000000000002',2035,NULL,$3,$3,'2035-01-01T00:00:00Z'),
         ('20000000-0000-4000-8000-000000000003',$4,$1,'LABORATORY','2035-08-03','COMPLETED',TRUE,'30000000-0000-4000-8000-000000000002',2035,'20000000-0000-4000-8000-000000000002',$3,$3,'2035-01-02T00:00:00Z'),
         ('20000000-0000-4000-8000-000000000004',$4,$1,'LABORATORY','2035-08-04','COMPLETED',TRUE,NULL,2035,NULL,$3,$3,'2035-01-01T00:00:00Z'),
         ('20000000-0000-4000-8000-000000000005',$4,$1,'LABORATORY','2035-08-04','NO_SHOW',TRUE,NULL,2035,NULL,$3,$3,'2035-01-03T00:00:00Z'),
         ('20000000-0000-4000-8000-000000000006',$4,$1,'LABORATORY','2035-08-04','PENDING',TRUE,NULL,2034,NULL,$3,$3,'2035-01-04T00:00:00Z')`,
      [
        pairedStudent,
        TEST_REFERENCE_IDS.physicalExamClinic,
        admin.userId,
        TEST_REFERENCE_IDS.laboratoryClinic,
      ],
    );

    const physicalExams = await listAppointments({
      clinicCode: "CPU_CLINIC",
      scheduleType: "PHYSICAL_EXAM",
      studentNumber: pairedStudent,
      page: 1,
      limit: 20,
      offset: 0,
      includeLaboratoryStatus: true,
    });
    expect(physicalExams.total).toBe(4);
    expect(physicalExams.items.map((item) => [item.appointmentDate, item.laboratoryStatus])).toEqual([
      ["2035-08-10", "PENDING"],
      ["2035-08-11", "COMPLETED"],
      ["2035-08-12", "NO_SHOW"],
      ["2035-08-13", null],
    ]);

    const completedPhysicalExams = await listAppointments({
      clinicCode: "CPU_CLINIC",
      scheduleType: "PHYSICAL_EXAM",
      status: "COMPLETED",
      studentNumber: pairedStudent,
      page: 1,
      limit: 1,
      offset: 1,
      includeLaboratoryStatus: true,
    });
    expect(completedPhysicalExams.total).toBe(2);
    expect(completedPhysicalExams.items).toEqual([
      expect.objectContaining({ appointmentDate: "2035-08-11", laboratoryStatus: "COMPLETED" }),
    ]);
  });

  it("keeps awaiting items out of clinic operations while exposing an unresolved student state", async () => {
    await insertTestStudent({
      studentNumber,
      firstName: "Awaiting",
      lastName: "Student",
      yearLevel: 4,
    });
    const awaiting = await pool.query<{ id: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_cycle_start,created_by,updated_by
       ) VALUES
         ($1,$3,'LABORATORY','2047-08-05','AWAITING_RESCHEDULE',TRUE,2047,$4,$4),
         ($2,$3,'PHYSICAL_EXAM','2047-08-06','NO_SHOW',TRUE,2047,$4,$4)
       RETURNING id::text`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        studentNumber,
        admin.userId,
      ],
    );
    const operational = await listAppointments({
      studentNumber,
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(operational.items).toEqual([expect.objectContaining({ status: "NO_SHOW" })]);
    await expect(getPublishedAppointment(awaiting.rows[0].id)).resolves.toMatchObject({
      id: awaiting.rows[0].id,
      status: "AWAITING_RESCHEDULE",
      isPublished: true,
    });

    const portal = await getStudentPortalSchedule(studentNumber);
    expect(portal).toMatchObject({
      appointments: expect.arrayContaining([
        expect.objectContaining({ appointmentDate: null, status: "AWAITING_RESCHEDULE" }),
        expect.objectContaining({ scheduleType: "PHYSICAL_EXAM", status: "NO_SHOW" }),
      ]),
      history: expect.arrayContaining([
        expect.objectContaining({ originalDate: "2047-08-05", status: "AWAITING_RESCHEDULE" }),
      ]),
    });
  });

  it("hides historical drafts everywhere normal, then exposes and operates them after publication", async () => {
    await insertTestStudent({
      studentNumber,
      firstName: "Ada Lynne",
      lastName: "Santos",
      suffix: "Jr.",
      yearLevel: 3,
    });
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO schedule_batches (clinic_id, batch_name, status, created_by)
       VALUES ($1,'TEST published guards historical generated','GENERATED',$2)
       RETURNING id`,
      [TEST_REFERENCE_IDS.laboratoryClinic, admin.userId],
    );
    await pool.query(
      `INSERT INTO appointments (
         batch_id, clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, created_by
       ) VALUES
         ($1,$2,$4,'LABORATORY','2027-02-08','DRAFT',FALSE,$5),
         ($1,$3,$4,'PHYSICAL_EXAM','2027-02-09','DRAFT',FALSE,$5)`,
      [
        batch.rows[0].id,
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        studentNumber,
        admin.userId,
      ],
    );

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
      [[batch.rows[0].id]],
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
    expect(await getStudentPortalSchedule(studentNumber)).toMatchObject({
      appointments: [],
    });

    await publishScheduleBatch(batch.rows[0].id, admin.userId);

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
    expect(await getStudentPortalSchedule(studentNumber)).toMatchObject({
      appointments: expect.arrayContaining([
        expect.objectContaining({ scheduleType: "LABORATORY" }),
      ]),
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
