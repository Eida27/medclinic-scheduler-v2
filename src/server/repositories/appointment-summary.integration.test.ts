// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import {
  cleanupTestFixtures,
  insertNumberedTestStudents,
  insertTestAcademicSnapshot,
  insertTestStudent,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";
import { appointmentSummaryReport } from "./appointment-summary.repository";
import { complianceReport } from "./tracking.repository";

const orderStudents = [
  ["TEST-ORDER-0001", "Aaron", "Alpha"],
  ["TEST-ORDER-0002", "Bella", "Beta"],
  ["TEST-ORDER-0003", "Clara", "Gamma"],
  ["TEST-ORDER-0004", "Dana", "Same"],
  ["TEST-ORDER-0005", "Dana", "Same"],
  ["TEST-ORDER-0006", "Inactive", "Zero"],
] as const;

const attendanceCases = [
  ["TEST-ATTENDANCE-0001", "COMPLETED", "COMPLETED", "COMPLETE"],
  ["TEST-ATTENDANCE-0002", "COMPLETED", "PENDING", "INCOMPLETE"],
  ["TEST-ATTENDANCE-0003", "NO_SHOW", "COMPLETED", "INCOMPLETE"],
  ["TEST-ATTENDANCE-0004", null, "COMPLETED", "INCOMPLETE"],
  ["TEST-ATTENDANCE-0005", "AWAITING_RESCHEDULE", "COMPLETED", "INCOMPLETE"],
] as const;

let attendanceReplacementId: string;
let createdYear = false;
let physicianId: string | null = null;

async function report(sort: Parameters<typeof appointmentSummaryReport>[0]["sort"]) {
  return appointmentSummaryReport({
    search: "TEST-ORDER-",
    sort,
    page: 1,
    limit: 150,
    offset: 0,
  });
}

beforeAll(async () => {
  await cleanupTestFixtures("TEST-ORDER-%", "TEST order fixture%", "TEST order fixture%");
  await cleanupTestFixtures("TEST-PAGE-%", "TEST page fixture%");
  await cleanupTestFixtures("TEST-ATTENDANCE-%", "TEST attendance fixture%", "TEST attendance fixture%");
  const year = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
    VALUES (2026,'2027-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
  [TEST_REFERENCE_IDS.adminUser]);
  createdYear = Boolean(year.rowCount);

  for (const [studentNumber, firstName, lastName] of orderStudents) {
    await insertTestStudent({ studentNumber, firstName, lastName, yearLevel: 4 });
  }
  await pool.query(
    `UPDATE students
        SET middle_name='Maria Angela', suffix='Jr.'
      WHERE student_number='TEST-ORDER-0001'`,
  );
  await pool.query("UPDATE students SET is_active=FALSE WHERE student_number='TEST-ORDER-0006'");
  await insertNumberedTestStudents("TEST-PAGE-", 151);
  for (const [index, [studentNumber]] of attendanceCases.entries()) {
    await insertTestStudent({
      studentNumber,
      firstName: "Attendance",
      lastName: String(index + 1).padStart(4, "0"),
      yearLevel: 4,
    });
  }

  await transaction(async (client) => {
    for (const [studentNumber] of orderStudents.slice(0, 5)) {
      await insertTestAcademicSnapshot(client, {
        studentNumber, academicYearStart: 2026,
        importName: `TEST order fixture provenance ${studentNumber}`,
        actor: TEST_REFERENCE_IDS.adminUser,
      });
    }
    for (const [studentNumber] of attendanceCases) {
      await insertTestAcademicSnapshot(client, {
        studentNumber, academicYearStart: 2026,
        importName: `TEST attendance fixture provenance ${studentNumber}`,
        actor: TEST_REFERENCE_IDS.adminUser,
      });
    }
  });

  await transaction(async (client) => {
  await client.query(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES
       ($1,'TEST-ORDER-0001','LABORATORY','2027-01-01','PENDING',TRUE,$3,$3),
       ($2,'TEST-ORDER-0001','PHYSICAL_EXAM','2027-03-01','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ORDER-0002','PHYSICAL_EXAM','2027-02-01','PENDING',TRUE,$3,$3),
       ($1,'TEST-ORDER-0004','LABORATORY','2027-01-01','PENDING',TRUE,$3,$3),
       ($1,'TEST-ORDER-0005','LABORATORY','2027-01-01','PENDING',TRUE,$3,$3)`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  await client.query(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES ($1,'TEST-ORDER-0003','LABORATORY','2027-01-15','CANCELLED',TRUE,$2,$2)`,
    [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
  );

  const attendanceAppointments = await client.query<{
    id: string;
    student_number: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES
       ($1,'TEST-ATTENDANCE-0001','LABORATORY','2027-04-01','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0001','PHYSICAL_EXAM','2027-04-08','COMPLETED',TRUE,$3,$3),
       ($1,'TEST-ATTENDANCE-0002','LABORATORY','2027-04-01','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0002','PHYSICAL_EXAM','2027-04-08','PENDING',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0003','PHYSICAL_EXAM','2027-04-08','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0004','PHYSICAL_EXAM','2027-04-08','COMPLETED',TRUE,$3,$3),
       ($1,'TEST-ATTENDANCE-0005','LABORATORY','2027-04-01','AWAITING_RESCHEDULE',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0005','PHYSICAL_EXAM','2027-04-08','COMPLETED',TRUE,$3,$3)
     RETURNING id, student_number, schedule_type`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const original = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES ($1,'TEST-ATTENDANCE-0003','LABORATORY','2027-04-01','RESCHEDULED',TRUE,$2,$2)
     RETURNING id`,
    [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
  );
  const replacement = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, rescheduled_from, created_by, updated_by
     ) VALUES ($1,'TEST-ATTENDANCE-0003','LABORATORY','2027-04-15','NO_SHOW',TRUE,$2,$3,$3)
     RETURNING id`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      original.rows[0].id,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  attendanceReplacementId = replacement.rows[0].id;

  const conflictingPhysical = attendanceAppointments.rows.find(
    (appointment) => appointment.student_number === "TEST-ATTENDANCE-0002"
      && appointment.schedule_type === "PHYSICAL_EXAM",
  );
  if (!conflictingPhysical) {
    throw new Error("Missing conflicting physical-exam appointment fixture");
  }
  await client.query(
    `INSERT INTO exam_results (
       student_number, appointment_id, result_status, completed_at, encoded_by
     ) VALUES ('TEST-ATTENDANCE-0002',$1,'REQUIRES_FOLLOW_UP','2027-04-08',$2)`,
    [conflictingPhysical.id, TEST_REFERENCE_IDS.adminUser],
  );
  await client.query(
    `INSERT INTO laboratory_results (
       student_number, result_status, completed_at, encoded_by
     ) VALUES ('TEST-ATTENDANCE-0004','COMPLETED','2027-04-01',$1)`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  await client.query(`UPDATE appointments SET schedule_cycle_start=2026,scheduling_category='REGULAR'
    WHERE student_number LIKE 'TEST-ORDER-%' OR student_number LIKE 'TEST-ATTENDANCE-%'`);
  const roots = await client.query<{ id: string }>(`SELECT id::text FROM appointments
    WHERE schedule_type='LABORATORY' AND is_published=TRUE AND rescheduled_from IS NULL
      AND (student_number LIKE 'TEST-ORDER-%' OR student_number LIKE 'TEST-ATTENDANCE-%')`);
  await linkPublishedLaboratoryAppointments(client, roots.rows.map((row) => row.id));
  await linkPublishedLaboratoryAppointments(client, [replacement.rows[0].id]);
  await client.query(`UPDATE laboratory_checklist_items SET verified_at=NOW(),
      verified_by=$1,verification_source='INTERNAL'
    WHERE checklist_id IN (SELECT link.checklist_id FROM laboratory_checklist_appointments link
      JOIN appointments appointment ON appointment.id=link.appointment_id
      WHERE appointment.status='COMPLETED' AND appointment.student_number LIKE 'TEST-ATTENDANCE-%')`,
  [TEST_REFERENCE_IDS.adminUser]);
  const physician = await client.query<{ id: string }>(
    "INSERT INTO medical_certificate_physicians DEFAULT VALUES RETURNING id::text",
  );
  physicianId = physician.rows[0].id;
  const signature = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer();
  const revision = await client.query<{ id: string }>(
    `INSERT INTO medical_certificate_physician_revisions (physician_id,version,display_name,
      license_number,signature_bytes,signature_media_type,actor_user_id,actor_snapshot)
     VALUES ($1,1,'Dr. Summary Fixture','PRC 12345',$2,'image/png',$3,$4::jsonb)
     RETURNING id::text`,
    [physicianId, signature, TEST_REFERENCE_IDS.adminUser,
      JSON.stringify({ userId: TEST_REFERENCE_IDS.adminUser })],
  );
  const completedPhysicalRows = await client.query<{ id: string; student_number: string; appointment_date: string }>(
    `SELECT id::text,student_number,appointment_date::text FROM appointments
      WHERE schedule_type='PHYSICAL_EXAM' AND status='COMPLETED'
        AND (student_number LIKE 'TEST-ORDER-%' OR student_number LIKE 'TEST-ATTENDANCE-%')`,
  );
  for (const physical of completedPhysicalRows.rows) {
    await client.query(`INSERT INTO exam_results (student_number,appointment_id,result_status,completed_at,encoded_by)
      VALUES ($1,$2,'COMPLETED',$3,$4)`, [physical.student_number, physical.id,
      physical.appointment_date, TEST_REFERENCE_IDS.adminUser]);
    await client.query(
      `INSERT INTO medical_certificate_revisions (certificate_id,appointment_id,student_number,
       academic_year_start,revision_number,status,physician_revision_id,student_snapshot,
       examination_snapshot,physician_snapshot,classification,examination_date,sex,
       template_version,jpeg_bytes,byte_length,sha256,issued_by,issued_by_snapshot,request_id)
       VALUES ($1,$2,$3,2026,1,'ISSUED',$4,$5::jsonb,$6::jsonb,$7::jsonb,'A',$8,
         'Female','integration-test-v1',$9,$10,$11,$12,$13::jsonb,$14)`,
      [randomUUID(), physical.id, physical.student_number, revision.rows[0].id,
        JSON.stringify({ studentNumber: physical.student_number }),
        JSON.stringify({ examinationDate: physical.appointment_date }),
        JSON.stringify({ displayName: "Dr. Summary Fixture" }),
        physical.appointment_date, jpg, jpg.length,
        createHash("sha256").update(jpg).digest("hex"), TEST_REFERENCE_IDS.adminUser,
        JSON.stringify({ userId: TEST_REFERENCE_IDS.adminUser }), randomUUID()],
    );
  }
  });
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-ORDER-%", "TEST order fixture%", "TEST order fixture%");
  await cleanupTestFixtures("TEST-PAGE-%", "TEST page fixture%");
  await cleanupTestFixtures("TEST-ATTENDANCE-%", "TEST attendance fixture%", "TEST attendance fixture%");
  if (physicianId) {
    await transaction(async (client) => {
      await client.query("ALTER TABLE medical_certificate_physician_revisions DISABLE TRIGGER medical_certificate_physician_revisions_immutable");
      await client.query("DELETE FROM medical_certificate_physician_revisions WHERE physician_id=$1", [physicianId]);
      await client.query("DELETE FROM medical_certificate_physicians WHERE id=$1", [physicianId]);
      await client.query("ALTER TABLE medical_certificate_physician_revisions ENABLE TRIGGER medical_certificate_physician_revisions_immutable");
    });
  }
  if (createdYear) await pool.query("DELETE FROM academic_years WHERE start_year=2026");
  await pool.end();
});

describe("appointment summary attendance", () => {
  const cases = [
    [{ laboratoryStatus: "COMPLETED" }, ["TEST-ATTENDANCE-0001", "TEST-ATTENDANCE-0002"]],
    [{ physicalExamStatus: "COMPLETED" }, [
      "TEST-ATTENDANCE-0001",
      "TEST-ATTENDANCE-0003",
      "TEST-ATTENDANCE-0004",
      "TEST-ATTENDANCE-0005",
    ]],
    [{ laboratoryStatus: "COMPLETED", physicalExamStatus: "COMPLETED" }, [
      "TEST-ATTENDANCE-0001",
    ]],
    [{ laboratoryStatus: "UNSCHEDULED", physicalExamStatus: "COMPLETED" }, [
      "TEST-ATTENDANCE-0004",
    ]],
    [{ overallStatus: "COMPLETE" }, ["TEST-ATTENDANCE-0001"]],
  ] as const;

  it.each(cases)("applies attendance combination %o to rows and metrics", async (filters, expected) => {
    const result = await appointmentSummaryReport({
      search: "TEST-ATTENDANCE-",
      ...filters,
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });

    expect(result.items.map((item) => item.studentNumber)).toEqual(expected);
    expect(result.total).toBe(expected.length);
    expect(result.summary.totalStudents).toBe(expected.length);
  });

  it("derives attendance independently from conflicting result rows", async () => {
    const result = await appointmentSummaryReport({
      search: "TEST-ATTENDANCE-",
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });

    const byStudent = new Map(result.items.map((item) => [item.studentNumber, item]));

    for (const [studentNumber, laboratoryStatus, physicalExamStatus, overallStatus]
      of attendanceCases) {
      expect(byStudent.get(studentNumber)).toMatchObject({
        laboratoryStatus: laboratoryStatus ?? "UNSCHEDULED",
        physicalExamStatus,
        overallStatus,
      });
    }
  });

  it("keeps awaiting rows in the combined summary without presenting the closed date as current", async () => {
    const result = await appointmentSummaryReport({
      search: "TEST-ATTENDANCE-0005",
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });
    expect(result).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        laboratoryStatus: "AWAITING_RESCHEDULE",
        laboratoryAppointmentDate: null,
        nextSchedule: null,
        overallStatus: "INCOMPLETE",
      })],
    });
  });

  it("returns the replacement appointment from a reschedule chain", async () => {
    const result = await appointmentSummaryReport({
      search: "TEST-ATTENDANCE-0003",
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });

    expect(result.items[0]).toMatchObject({
      laboratoryAppointmentId: attendanceReplacementId,
      laboratoryAppointmentDate: "2027-04-15",
      laboratoryAppointmentStatus: "NO_SHOW",
      laboratoryStatus: "NO_SHOW",
    });
  });
});

describe("appointment summary ordering and pagination", () => {
  it.each([
    ["upcoming_asc", ["TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0002", "TEST-ORDER-0003"]],
    ["upcoming_desc", ["TEST-ORDER-0002", "TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0003"]],
    ["name_asc", ["TEST-ORDER-0001", "TEST-ORDER-0002", "TEST-ORDER-0003", "TEST-ORDER-0004", "TEST-ORDER-0005"]],
    ["name_desc", ["TEST-ORDER-0005", "TEST-ORDER-0004", "TEST-ORDER-0003", "TEST-ORDER-0002", "TEST-ORDER-0001"]],
    ["attention_first", ["TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0002", "TEST-ORDER-0003"]],
    ["completed_first", ["TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0002", "TEST-ORDER-0003"]],
  ] as const)("returns the real %s order with nulls and stable ties", async (sort, expected) => {
    const result = await report(sort);
    expect(result.items.map((item) => item.studentNumber)).toEqual(expected);
    expect(result.items.find((item) => item.studentNumber === "TEST-ORDER-0001")?.studentName)
      .toBe("Alpha, Aaron Maria Angela (Jr.)");
    expect(result.items.find((item) => item.studentNumber === "TEST-ORDER-0001"))
      .toMatchObject({ physicalExamStatus: "COMPLETED", laboratoryStatus: "PENDING" });
  });

  it.each(["Alpha, Aaron", "Aaron Alpha"])(
    "finds a student using the %s search order",
    async (search) => {
      const result = await appointmentSummaryReport({
        search,
        sort: "name_asc",
        page: 1,
        limit: 20,
        offset: 0,
      });

      expect(result.items.map((item) => item.studentNumber)).toContain("TEST-ORDER-0001");
    },
  );

  it("returns current attendance and excludes inactive students", async () => {
    const result = await report("name_asc");
    const cancelled = result.items.find((item) => item.studentNumber === "TEST-ORDER-0003");

    expect(cancelled).toMatchObject({
      physicalExamStatus: "UNSCHEDULED",
      laboratoryStatus: "CANCELLED",
      overallStatus: "INCOMPLETE",
      nextSchedule: null,
    });
    expect(result.items.some((item) => item.studentNumber === "TEST-ORDER-0006")).toBe(false);
  });

  it("calculates metrics from the complete filtered result", async () => {
    const result = await appointmentSummaryReport({
      search: "TEST-ATTENDANCE-",
      overallStatus: "COMPLETE",
      sort: "upcoming_asc",
      page: 1,
      limit: 1,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.summary).toEqual({
      totalStudents: 1,
      physicalCompleted: 1,
      laboratoryCompleted: 1,
      pendingAny: 0,
    });
  });

  it("returns exactly 150 rows on page one and the remaining row on page two", async () => {
    const first = await appointmentSummaryReport({
      search: "TEST-PAGE-",
      sort: "name_asc",
      page: 1,
      limit: 150,
      offset: 0,
    });
    const second = await appointmentSummaryReport({
      search: "TEST-PAGE-",
      sort: "name_asc",
      page: 2,
      limit: 150,
      offset: 150,
    });

    expect(first.total).toBe(151);
    expect(first.items).toHaveLength(150);
    expect(first.items[0].studentNumber).toBe("TEST-PAGE-0001");
    expect(first.items[149].studentNumber).toBe("TEST-PAGE-0150");
    expect(second.items.map((item) => item.studentNumber)).toEqual(["TEST-PAGE-0151"]);
  });
});

describe("legacy compliance filters", () => {
  it("keeps legacy appointment status and clinic filters tied to the retained latest appointment", async () => {
    const pageFilter = await appointmentSummaryReport({
      search: "TEST-ORDER-0001",
      appointmentStatus: "PENDING",
      sort: "upcoming_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });
    const legacyPending = await complianceReport({
      search: "TEST-ORDER-0001",
      appointmentStatus: "PENDING",
      page: 1,
      limit: 20,
      offset: 0,
    });
    const legacyCompleted = await complianceReport({
      search: "TEST-ORDER-0001",
      appointmentStatus: "COMPLETED",
      clinicCode: "CPU_CLINIC",
      page: 1,
      limit: 20,
      offset: 0,
    });
    const wrongClinic = await complianceReport({
      search: "TEST-ORDER-0001",
      clinicCode: "KABALAKA_CLINIC",
      page: 1,
      limit: 20,
      offset: 0,
    });

    expect(pageFilter.total).toBe(1);
    expect(legacyPending.total).toBe(0);
    expect(legacyCompleted.items[0]).toMatchObject({ appointmentStatus: "COMPLETED" });
    expect(wrongClinic.total).toBe(0);
  });
});
