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

const completionStudents = [
  ["TEST-COMPLETION-0001", "Both", "Completed"],
  ["TEST-COMPLETION-0002", "Lab", "Pending"],
  ["TEST-COMPLETION-0003", "Lab", "Followup"],
  ["TEST-COMPLETION-0004", "Both", "Pending"],
] as const;

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
  await cleanupTestFixtures("TEST-COMPLETION-%", "TEST completion fixture%");

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
  for (const [studentNumber, firstName, lastName] of completionStudents) {
    await insertTestStudent({ studentNumber, firstName, lastName, yearLevel: 4 });
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
  const cancelled = await pool.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id, student_number, schedule_type, appointment_date,
       status, is_published, created_by, updated_by
     ) VALUES ($1,'TEST-ORDER-0003','LABORATORY','2046-01-15','CANCELLED',TRUE,$2,$2)
     RETURNING id`,
    [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.adminUser],
  );

  await pool.query(
    `INSERT INTO exam_results (
       student_number, result_status, completed_at, encoded_by, created_at, updated_at
     ) VALUES
       ('TEST-ORDER-0002','COMPLETED','2045-12-01',$1,'2045-12-01','2045-12-01'),
       ('TEST-ORDER-0003','COMPLETED','2046-01-01',$1,'2025-01-01','2025-01-01'),
       ('TEST-ORDER-0003','REQUIRES_FOLLOW_UP',NULL,$1,'2026-01-01','2026-01-01')`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  await pool.query(
    `INSERT INTO laboratory_results (
       student_number, appointment_id, result_status, completed_at,
       encoded_by, created_at, updated_at
     ) VALUES
       ('TEST-ORDER-0002',NULL,'COMPLETED','2045-12-01',$1,'2045-12-01','2045-12-01'),
       ('TEST-ORDER-0003',NULL,'COMPLETED','2045-12-15',$1,'2025-01-01','2025-01-01'),
       ('TEST-ORDER-0003',$2,'REQUIRES_FOLLOW_UP','2046-01-15',$1,'2027-01-01','2027-01-01')`,
    [TEST_REFERENCE_IDS.adminUser, cancelled.rows[0].id],
  );
  await pool.query(
    `INSERT INTO exam_results (
       student_number, result_status, completed_at, encoded_by
     ) VALUES
       ('TEST-COMPLETION-0001','COMPLETED','2046-01-01',$1),
       ('TEST-COMPLETION-0002','COMPLETED','2046-01-01',$1),
       ('TEST-COMPLETION-0003','COMPLETED','2046-01-01',$1)`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  await pool.query(
    `INSERT INTO laboratory_results (
       student_number, result_status, completed_at, encoded_by
     ) VALUES
       ('TEST-COMPLETION-0001','COMPLETED','2046-01-01',$1),
       ('TEST-COMPLETION-0002','PENDING_UPLOAD',NULL,$1),
       ('TEST-COMPLETION-0003','REQUIRES_FOLLOW_UP',NULL,$1)`,
    [TEST_REFERENCE_IDS.adminUser],
  );
});

afterAll(async () => {
  await cleanupTestFixtures("TEST-ORDER-%", "TEST order fixture%");
  await cleanupTestFixtures("TEST-PAGE-%", "TEST page fixture%");
  await cleanupTestFixtures("TEST-COMPLETION-%", "TEST completion fixture%");
  await pool.end();
});

describe("appointment summary completion filters", () => {
  const cases = [
    [{ laboratoryStatus: "COMPLETED" }, ["TEST-COMPLETION-0001"]],
    [{ physicalExamStatus: "COMPLETED" }, [
      "TEST-COMPLETION-0001",
      "TEST-COMPLETION-0003",
      "TEST-COMPLETION-0002",
    ]],
    [{ laboratoryStatus: "COMPLETED", physicalExamStatus: "COMPLETED" }, [
      "TEST-COMPLETION-0001",
    ]],
    [{ laboratoryStatus: "PENDING_UPLOAD", physicalExamStatus: "COMPLETED" }, [
      "TEST-COMPLETION-0002",
    ]],
    [{ overallStatus: "COMPLETE" }, ["TEST-COMPLETION-0001"]],
    [{ overallStatus: "FOLLOW_UP" }, ["TEST-COMPLETION-0003"]],
  ] as const;

  it.each(cases)("applies completion combination %o to rows and metrics", async (filters, expected) => {
    const result = await appointmentSummaryReport({
      search: "TEST-COMPLETION-",
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

  it("treats explicit placeholders and absent result rows as pending uploads", async () => {
    const result = await appointmentSummaryReport({
      search: "TEST-COMPLETION-",
      laboratoryStatus: "PENDING_UPLOAD",
      sort: "name_asc",
      page: 1,
      limit: 20,
      offset: 0,
    });

    expect(result.items.map((item) => item.studentNumber)).toEqual([
      "TEST-COMPLETION-0004",
      "TEST-COMPLETION-0002",
    ]);
    expect(result.total).toBe(2);
    expect(result.summary.totalStudents).toBe(2);
  });
});

describe("appointment summary ordering and pagination", () => {
  it.each([
    ["upcoming_asc", ["TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0002", "TEST-ORDER-0003"]],
    ["upcoming_desc", ["TEST-ORDER-0002", "TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0003"]],
    ["name_asc", ["TEST-ORDER-0001", "TEST-ORDER-0002", "TEST-ORDER-0003", "TEST-ORDER-0004", "TEST-ORDER-0005"]],
    ["name_desc", ["TEST-ORDER-0005", "TEST-ORDER-0004", "TEST-ORDER-0003", "TEST-ORDER-0002", "TEST-ORDER-0001"]],
    ["attention_first", ["TEST-ORDER-0003", "TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0002"]],
    ["completed_first", ["TEST-ORDER-0002", "TEST-ORDER-0001", "TEST-ORDER-0004", "TEST-ORDER-0005", "TEST-ORDER-0003"]],
  ] as const)("returns the real %s order with nulls and stable ties", async (sort, expected) => {
    const result = await report(sort);
    expect(result.items.map((item) => item.studentNumber)).toEqual(expected);
    expect(result.items.find((item) => item.studentNumber === "TEST-ORDER-0001")?.studentName)
      .toBe("Alpha, Aaron M. (Jr.)");
    expect(result.items.find((item) => item.studentNumber === "TEST-ORDER-0001"))
      .toMatchObject({ physicalExamStatus: "PENDING_UPLOAD", laboratoryStatus: "PENDING_UPLOAD" });
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

  it("uses the newest eligible results and excludes cancelled-linked results", async () => {
    const result = await report("name_asc");
    const followUp = result.items.find((item) => item.studentNumber === "TEST-ORDER-0003");

    expect(followUp).toMatchObject({
      physicalExamStatus: "REQUIRES_FOLLOW_UP",
      laboratoryStatus: "COMPLETED",
      overallStatus: "FOLLOW_UP",
      nextSchedule: null,
    });
    expect(result.items.some((item) => item.studentNumber === "TEST-ORDER-0006")).toBe(false);
  });

  it("calculates metrics from the complete filtered result", async () => {
    const result = await appointmentSummaryReport({
      search: "TEST-ORDER-",
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
