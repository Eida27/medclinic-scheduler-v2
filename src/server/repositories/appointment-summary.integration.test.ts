// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import {
  cleanupTestFixtures,
  insertNumberedTestStudents,
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
] as const;

let attendanceReplacementId: string;

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
  await cleanupTestFixtures("TEST-ORDER-%", "TEST order fixture%");
  await cleanupTestFixtures("TEST-PAGE-%", "TEST page fixture%");
  await cleanupTestFixtures("TEST-ATTENDANCE-%", "TEST attendance fixture%");

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

  await pool.query(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES
       ($1,'TEST-ORDER-0001','LABORATORY','2046-01-01','PENDING',TRUE,$3,$3),
       ($2,'TEST-ORDER-0001','PHYSICAL_EXAM','2046-03-01','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ORDER-0002','PHYSICAL_EXAM','2046-02-01','PENDING',TRUE,$3,$3),
       ($1,'TEST-ORDER-0004','LABORATORY','2046-01-01','PENDING',TRUE,$3,$3),
       ($1,'TEST-ORDER-0005','LABORATORY','2046-01-01','PENDING',TRUE,$3,$3)`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  await pool.query(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES ($1,'TEST-ORDER-0003','LABORATORY','2046-01-15','CANCELLED',TRUE,$2,$2)`,
    [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
  );

  const attendanceAppointments = await pool.query<{
    id: string;
    student_number: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES
       ($1,'TEST-ATTENDANCE-0001','LABORATORY','2046-04-01','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0001','PHYSICAL_EXAM','2046-04-08','COMPLETED',TRUE,$3,$3),
       ($1,'TEST-ATTENDANCE-0002','LABORATORY','2046-04-01','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0002','PHYSICAL_EXAM','2046-04-08','PENDING',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0003','PHYSICAL_EXAM','2046-04-08','COMPLETED',TRUE,$3,$3),
       ($2,'TEST-ATTENDANCE-0004','PHYSICAL_EXAM','2046-04-08','COMPLETED',TRUE,$3,$3)
     RETURNING id, student_number, schedule_type`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const original = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES ($1,'TEST-ATTENDANCE-0003','LABORATORY','2046-04-01','RESCHEDULED',TRUE,$2,$2)
     RETURNING id`,
    [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
  );
  const replacement = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, rescheduled_from, created_by, updated_by
     ) VALUES ($1,'TEST-ATTENDANCE-0003','LABORATORY','2046-04-15','NO_SHOW',TRUE,$2,$3,$3)
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
  await pool.query(
    `INSERT INTO exam_results (
       student_number, appointment_id, result_status, completed_at, encoded_by
     ) VALUES ('TEST-ATTENDANCE-0002',$1,'COMPLETED','2046-04-08',$2)`,
    [conflictingPhysical.id, TEST_REFERENCE_IDS.adminUser],
  );
  await pool.query(
    `INSERT INTO laboratory_results (
       student_number, result_status, completed_at, encoded_by
     ) VALUES ('TEST-ATTENDANCE-0004','COMPLETED','2046-04-01',$1)`,
    [TEST_REFERENCE_IDS.adminUser],
  );
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-ORDER-%", "TEST order fixture%");
  await cleanupTestFixtures("TEST-PAGE-%", "TEST page fixture%");
  await cleanupTestFixtures("TEST-ATTENDANCE-%", "TEST attendance fixture%");
  await pool.end();
});

describe("appointment summary attendance", () => {
  const cases = [
    [{ laboratoryStatus: "COMPLETED" }, ["TEST-ATTENDANCE-0001", "TEST-ATTENDANCE-0002"]],
    [{ physicalExamStatus: "COMPLETED" }, [
      "TEST-ATTENDANCE-0001",
      "TEST-ATTENDANCE-0003",
      "TEST-ATTENDANCE-0004",
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
      laboratoryAppointmentDate: "2046-04-15",
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
      .toBe("Alpha, Aaron M. (Jr.)");
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
