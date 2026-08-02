// @vitest-environment node
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { pool } from "@/server/db/pool";
import {
  getHistoricalComplianceExportData,
  getHistoricalComplianceReport,
} from "@/server/services/historical-compliance-report.service";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";

const YEAR = 2088;
const NEXT_YEAR = 2089;
const colleges = {
  alpha: "71000000-0000-4000-8000-000000000001",
  beta: "71000000-0000-4000-8000-000000000002",
  current: "71000000-0000-4000-8000-000000000003",
};
const programs = {
  alpha: "72000000-0000-4000-8000-000000000001",
  zulu: "72000000-0000-4000-8000-000000000002",
  beta: "72000000-0000-4000-8000-000000000003",
  betaAlpha: "72000000-0000-4000-8000-000000000004",
  current: "72000000-0000-4000-8000-000000000005",
};

let client: PoolClient;

async function insertAppointment(input: {
  studentNumber: string;
  cycle?: number;
  type: "LABORATORY" | "PHYSICAL_EXAM";
  date: string;
  status: string;
  published?: boolean;
  rescheduledFrom?: string;
}) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,
       is_published,rescheduled_from,schedule_cycle_start,created_by,updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [
      input.type === "LABORATORY"
        ? TEST_REFERENCE_IDS.laboratoryClinic
        : TEST_REFERENCE_IDS.physicalExamClinic,
      input.studentNumber,
      input.type,
      input.date,
      input.status,
      input.published ?? true,
      input.rescheduledFrom ?? null,
      input.cycle ?? YEAR,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  return result.rows[0].id;
}

async function insertSnapshot(input: {
  studentNumber: string;
  cycle?: number;
  name: string;
  collegeId: string;
  collegeName: string;
  programId: string;
  programCode: string;
  programName: string;
  yearLevel: number;
  sourceType?: string;
}) {
  await client.query(
    `INSERT INTO student_academic_snapshots (
       student_number,academic_year_start,student_name,college_id,college_name,
       program_id,program_code,program_name,year_level,source_type
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.studentNumber,
      input.cycle ?? YEAR,
      input.name,
      input.collegeId,
      input.collegeName,
      input.programId,
      input.programCode,
      input.programName,
      input.yearLevel,
      input.sourceType ?? "VERIFIED_HISTORICAL",
    ],
  );
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,'2089-07-31',$3,$3),($2,'2090-07-31',$3,$3)`,
    [YEAR, NEXT_YEAR, TEST_REFERENCE_IDS.adminUser],
  );
  await client.query(
    `INSERT INTO colleges (id,code,name) VALUES
       ($1,'RPT-A','Historic Alpha College'),
       ($2,'RPT-B','Historic Beta College'),
       ($3,'RPT-C','Current College')`,
    [colleges.alpha, colleges.beta, colleges.current],
  );
  await client.query(
    `INSERT INTO programs (id,college_id,code,name) VALUES
       ($1,$6,'ALPHA','Alpha Program'),
       ($2,$6,'ZULU','Zulu Program'),
       ($3,$7,'BETA','Beta Program'),
       ($4,$7,'A-BETA','Alpha Beta Program'),
       ($5,$8,'CURRENT','Current Program')`,
    [
      programs.alpha,
      programs.zulu,
      programs.beta,
      programs.betaAlpha,
      programs.current,
      colleges.alpha,
      colleges.beta,
      colleges.current,
    ],
  );

  const students = [
    ["RPT-CORE-0001", "Stable", "Student", true],
    ["RPT-CORE-0002", "Inactive", "Student", false],
    ["RPT-YEAR-0001", "Yearly", "Student", true],
    ["RPT-SORT-A", "Sort", "A", true],
    ["RPT-SORT-B", "Sort", "B", true],
    ["RPT-SORT-C", "Sort", "C", true],
    ["RPT-SORT-D", "Sort", "D", true],
    ["RPT-STATE-LAB", "State", "Laboratory", true],
    ["RPT-STATE-PHYS", "State", "Physical", true],
    ["RPT-STATE-BOTH", "State", "Both", true],
    ["RPT-STATE-COMPLIED", "State", "Complied", true],
    ["RPT-TUPLE-ALPHA", "Tuple", "Alpha", true],
    ["RPT-TUPLE-BETA", "Tuple", "Beta", true],
  ];
  await client.query(
    `INSERT INTO students (
       student_number,first_name,last_name,college_id,program_id,year_level,is_active
     ) SELECT row.student_number,row.first_name,row.last_name,$2,$3,4,row.is_active
         FROM jsonb_to_recordset($1::jsonb) AS row(
           student_number text,first_name text,last_name text,is_active boolean
         )`,
    [
      JSON.stringify(students.map(([student_number, first_name, last_name, is_active]) => ({
        student_number, first_name, last_name, is_active,
      }))),
      colleges.current,
      programs.current,
    ],
  );

  await insertSnapshot({
    studentNumber: "RPT-CORE-0001", name: "Stable, Historical Student",
    collegeId: colleges.alpha, collegeName: "Historic Alpha College",
    programId: programs.alpha, programCode: "ALPHA", programName: "Alpha Program",
    yearLevel: 2, sourceType: "RECOVERED_HISTORICAL",
  });
  await insertSnapshot({
    studentNumber: "RPT-CORE-0002", name: "Inactive, Historical Student",
    collegeId: colleges.beta, collegeName: "Historic Beta College",
    programId: programs.beta, programCode: "BETA", programName: "Beta Program",
    yearLevel: 3, sourceType: "MIGRATED_INCOMPLETE",
  });
  await insertSnapshot({
    studentNumber: "RPT-YEAR-0001", name: "Yearly, First Snapshot",
    collegeId: colleges.alpha, collegeName: "Historic Alpha College",
    programId: programs.alpha, programCode: "ALPHA", programName: "Alpha Program",
    yearLevel: 1,
  });
  await insertSnapshot({
    studentNumber: "RPT-YEAR-0001", cycle: NEXT_YEAR, name: "Yearly, Second Snapshot",
    collegeId: colleges.beta, collegeName: "Historic Beta College",
    programId: programs.beta, programCode: "BETA", programName: "Beta Program",
    yearLevel: 2,
  });
  await insertSnapshot({
    studentNumber: "RPT-TUPLE-ALPHA", name: "Tuple, Alpha",
    collegeId: colleges.alpha, collegeName: "Historic Alpha College",
    programId: programs.alpha, programCode: "ALPHA", programName: "Alpha Program",
    yearLevel: 2,
  });
  await insertSnapshot({
    studentNumber: "RPT-TUPLE-BETA", name: "Tuple, Beta",
    collegeId: colleges.beta, collegeName: "Historic Beta College",
    programId: programs.alpha, programCode: "REASSIGNED", programName: "Reassigned Program",
    yearLevel: 3,
  });

  const sortSnapshots = [
    ["RPT-SORT-A", "Beta, Aaron", colleges.alpha, "Historic Alpha College", programs.zulu, "ZULU", "Zulu Program", 2],
    ["RPT-SORT-B", "Alpha, Bea", colleges.alpha, "Historic Alpha College", programs.alpha, "ALPHA", "Alpha Program", 3],
    ["RPT-SORT-C", "Delta, Cara", colleges.beta, "Historic Beta College", programs.beta, "BETA", "Beta Program", 1],
    ["RPT-SORT-D", "Charlie, Dan", colleges.beta, "Historic Beta College", programs.betaAlpha, "A-BETA", "Alpha Beta Program", 1],
  ] as const;
  for (const row of sortSnapshots) {
    await insertSnapshot({
      studentNumber: row[0], name: row[1], collegeId: row[2], collegeName: row[3],
      programId: row[4], programCode: row[5], programName: row[6], yearLevel: row[7],
    });
  }

  const stateSnapshots = [
    ["RPT-STATE-LAB", "State, Laboratory"],
    ["RPT-STATE-PHYS", "State, Physical"],
    ["RPT-STATE-BOTH", "State, Both"],
    ["RPT-STATE-COMPLIED", "State, Complied"],
  ] as const;
  for (const [studentNumber, name] of stateSnapshots) {
    await insertSnapshot({
      studentNumber,
      name,
      collegeId: colleges.alpha,
      collegeName: "Historic Alpha College",
      programId: programs.alpha,
      programCode: "ALPHA",
      programName: "Alpha Program",
      yearLevel: 2,
    });
  }

  const replaced = await insertAppointment({
    studentNumber: "RPT-CORE-0001", type: "LABORATORY", date: "2088-09-01", status: "NO_SHOW",
  });
  await insertAppointment({
    studentNumber: "RPT-CORE-0001", type: "LABORATORY", date: "2088-09-15",
    status: "COMPLETED", rescheduledFrom: replaced,
  });
  await insertAppointment({
    studentNumber: "RPT-CORE-0001", type: "LABORATORY", date: "2089-07-01",
    status: "NO_SHOW", published: false,
  });
  await insertAppointment({
    studentNumber: "RPT-CORE-0001", type: "PHYSICAL_EXAM", date: "2088-10-01", status: "COMPLETED",
  });
  await insertAppointment({
    studentNumber: "RPT-CORE-0002", type: "LABORATORY", date: "2088-11-01", status: "PENDING",
  });
  await insertAppointment({
    studentNumber: "RPT-YEAR-0001", type: "LABORATORY", date: "2088-12-01", status: "COMPLETED",
  });
  await insertAppointment({
    studentNumber: "RPT-YEAR-0001", cycle: NEXT_YEAR, type: "PHYSICAL_EXAM", date: "2089-12-01", status: "COMPLETED",
  });
  await insertAppointment({ studentNumber: "RPT-TUPLE-ALPHA", type: "LABORATORY", date: "2088-10-01", status: "PENDING" });
  await insertAppointment({ studentNumber: "RPT-TUPLE-BETA", type: "LABORATORY", date: "2088-10-02", status: "PENDING" });

  for (const number of ["RPT-SORT-A", "RPT-SORT-D"]) {
    await insertAppointment({ studentNumber: number, type: "LABORATORY", date: "2088-09-01", status: "COMPLETED" });
    await insertAppointment({ studentNumber: number, type: "PHYSICAL_EXAM", date: "2088-09-02", status: "COMPLETED" });
  }
  await insertAppointment({ studentNumber: "RPT-SORT-B", type: "LABORATORY", date: "2088-09-01", status: "PENDING" });
  await insertAppointment({ studentNumber: "RPT-SORT-C", type: "LABORATORY", date: "2088-09-01", status: "COMPLETED" });
  await insertAppointment({ studentNumber: "RPT-SORT-C", type: "PHYSICAL_EXAM", date: "2088-09-02", status: "NO_SHOW" });

  await insertAppointment({ studentNumber: "RPT-STATE-LAB", type: "LABORATORY", date: "2088-09-01", status: "PENDING" });
  await insertAppointment({ studentNumber: "RPT-STATE-LAB", type: "PHYSICAL_EXAM", date: "2088-09-02", status: "COMPLETED" });
  await insertAppointment({ studentNumber: "RPT-STATE-PHYS", type: "LABORATORY", date: "2088-09-01", status: "COMPLETED" });
  await insertAppointment({ studentNumber: "RPT-STATE-PHYS", type: "PHYSICAL_EXAM", date: "2088-09-02", status: "NO_SHOW" });
  await insertAppointment({ studentNumber: "RPT-STATE-BOTH", type: "LABORATORY", date: "2088-09-01", status: "PENDING" });
  await insertAppointment({ studentNumber: "RPT-STATE-BOTH", type: "PHYSICAL_EXAM", date: "2088-09-02", status: "CANCELLED" });
  await insertAppointment({ studentNumber: "RPT-STATE-COMPLIED", type: "LABORATORY", date: "2088-09-01", status: "COMPLETED" });
  await insertAppointment({ studentNumber: "RPT-STATE-COMPLIED", type: "PHYSICAL_EXAM", date: "2088-09-02", status: "COMPLETED" });

  await client.query(
    `INSERT INTO students (
       student_number,first_name,last_name,college_id,program_id,year_level
     ) SELECT 'RPT-PAGE-' || LPAD(value::text,4,'0'),'Page',LPAD(value::text,4,'0'),$1,$2,4
         FROM generate_series(1,151) value`,
    [colleges.current, programs.current],
  );
  await client.query(
    `INSERT INTO student_academic_snapshots (
       student_number,academic_year_start,student_name,college_id,college_name,
       program_id,program_code,program_name,year_level,source_type
     ) SELECT student_number,$1,'Tied Page, Student',$2,'Historic Alpha College',
              $3,'ALPHA','Alpha Program',4,'VERIFIED_HISTORICAL'
         FROM students WHERE student_number LIKE 'RPT-PAGE-%'`,
    [YEAR, colleges.alpha, programs.alpha],
  );
  await client.query(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_cycle_start,created_by,updated_by
     ) SELECT $1,student_number,'LABORATORY','2088-09-01','PENDING',TRUE,$2,$3,$3
         FROM students WHERE student_number LIKE 'RPT-PAGE-%'`,
    [TEST_REFERENCE_IDS.laboratoryClinic, YEAR, TEST_REFERENCE_IDS.adminUser],
  );

  await client.query("UPDATE colleges SET name='Renamed Mutable College' WHERE id=$1", [colleges.alpha]);
  await client.query("UPDATE programs SET name='Renamed Mutable Program' WHERE id=$1", [programs.alpha]);
});

afterAll(async () => {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
});

const closedNow = new Date("2091-08-01T00:00:00.000Z");

describe("historical academic-year report states", () => {
  it.each([
    ["OPEN", new Date("2089-07-01T00:00:00.000Z")],
    ["CLOSING_SOON", new Date("2089-07-20T00:00:00.000Z")],
  ] as const)("classifies every incomplete row as pending while the year is %s", async (_state, now) => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-STATE-", sort: "name_asc",
    }, now, client);
    expect(Object.fromEntries(report.items.map((row) => [row.studentNumber, row.overallStatus])))
      .toEqual({
        "RPT-STATE-BOTH": "PENDING_COMPLIANCE",
        "RPT-STATE-COMPLIED": "COMPLIED",
        "RPT-STATE-LAB": "PENDING_COMPLIANCE",
        "RPT-STATE-PHYS": "PENDING_COMPLIANCE",
      });
  });

  it("classifies each missing-requirement shape separately after the year closes", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-STATE-", sort: "name_asc",
    }, closedNow, client);
    expect(Object.fromEntries(report.items.map((row) => [row.studentNumber, row.overallStatus])))
      .toEqual({
        "RPT-STATE-BOTH": "DID_NOT_COMPLY_BOTH",
        "RPT-STATE-COMPLIED": "COMPLIED",
        "RPT-STATE-LAB": "DID_NOT_COMPLY_LABORATORY",
        "RPT-STATE-PHYS": "DID_NOT_COMPLY_PHYSICAL_EXAM",
      });
  });
});

describe("historical report attendance and overall filters", () => {
  it("filters laboratory status independently of physical-exam status", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR),
      search: "RPT-STATE-",
      laboratoryStatus: "PENDING",
      sort: "name_asc",
    }, closedNow, client);
    expect(report.items.map((row) => [row.studentNumber, row.physicalExamStatus])).toEqual([
      ["RPT-STATE-BOTH", "CANCELLED"],
      ["RPT-STATE-LAB", "COMPLETED"],
    ]);
  });

  it("filters physical-exam status independently of laboratory status", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR),
      search: "RPT-STATE-",
      physicalExamStatus: "NO_SHOW",
    }, closedNow, client);
    expect(report.items.map((row) => [row.studentNumber, row.laboratoryStatus])).toEqual([
      ["RPT-STATE-PHYS", "COMPLETED"],
    ]);
  });

  it("filters fully completed rows with the complied overall status", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR),
      search: "RPT-STATE-",
      overallStatus: "COMPLIED",
    }, closedNow, client);
    expect(report.items.map((row) => row.studentNumber)).toEqual(["RPT-STATE-COMPLIED"]);
  });

  it("filters incomplete open-year rows with the pending overall status", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR),
      search: "RPT-STATE-",
      overallStatus: "PENDING_COMPLIANCE",
      sort: "name_asc",
    }, new Date("2089-07-01T00:00:00.000Z"), client);
    expect(report.items.map((row) => row.studentNumber)).toEqual([
      "RPT-STATE-BOTH",
      "RPT-STATE-LAB",
      "RPT-STATE-PHYS",
    ]);
  });

  it("includes every closed subtype in the did-not-comply umbrella", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR),
      search: "RPT-STATE-",
      overallStatus: "DID_NOT_COMPLY",
      sort: "name_asc",
    }, closedNow, client);
    expect(report.items.map((row) => [row.studentNumber, row.overallStatus])).toEqual([
      ["RPT-STATE-BOTH", "DID_NOT_COMPLY_BOTH"],
      ["RPT-STATE-LAB", "DID_NOT_COMPLY_LABORATORY"],
      ["RPT-STATE-PHYS", "DID_NOT_COMPLY_PHYSICAL_EXAM"],
    ]);
  });
});

describe("historical report stable final tie-breakers", () => {
  it.each([
    ["college_asc", "RPT-PAGE-0001", "RPT-PAGE-0150", "RPT-PAGE-0151"],
    ["college_desc", "RPT-PAGE-0151", "RPT-PAGE-0002", "RPT-PAGE-0001"],
    ["program_asc", "RPT-PAGE-0001", "RPT-PAGE-0150", "RPT-PAGE-0151"],
    ["program_desc", "RPT-PAGE-0151", "RPT-PAGE-0002", "RPT-PAGE-0001"],
    ["year_asc", "RPT-PAGE-0001", "RPT-PAGE-0150", "RPT-PAGE-0151"],
    ["year_desc", "RPT-PAGE-0151", "RPT-PAGE-0002", "RPT-PAGE-0001"],
    ["name_asc", "RPT-PAGE-0001", "RPT-PAGE-0150", "RPT-PAGE-0151"],
    ["name_desc", "RPT-PAGE-0151", "RPT-PAGE-0002", "RPT-PAGE-0001"],
    ["attention_first", "RPT-PAGE-0001", "RPT-PAGE-0150", "RPT-PAGE-0151"],
    ["completed_first", "RPT-PAGE-0001", "RPT-PAGE-0150", "RPT-PAGE-0151"],
  ] as const)(
    "uses the student-number tie-breaker for %s across the page boundary",
    async (sort, firstStudent, lastOnFirstPage, onlyOnSecondPage) => {
      const first = await getHistoricalComplianceReport({
        academicYearStart: String(YEAR), search: "RPT-PAGE-", page: "1", sort,
      }, closedNow, client);
      const second = await getHistoricalComplianceReport({
        academicYearStart: String(YEAR), search: "RPT-PAGE-", page: "2", sort,
      }, closedNow, client);
      expect(first.total).toBe(151);
      expect(first.items).toHaveLength(150);
      expect(first.items.at(0)?.studentNumber).toBe(firstStudent);
      expect(first.items.at(-1)?.studentNumber).toBe(lastOnFirstPage);
      expect(second.items.map((row) => row.studentNumber)).toEqual([onlyOnSecondPage]);
    },
  );
});

describe("historical compliance report service", () => {
  it("requires a valid configured academic year before executing", async () => {
    await expect(getHistoricalComplianceReport({}, closedNow, client)).rejects.toMatchObject({
      code: "ACADEMIC_YEAR_REQUIRED", status: 400,
    } satisfies Partial<AppError>);
    await expect(getHistoricalComplianceReport(
      { academicYearStart: "2098" }, closedNow, client,
    )).rejects.toMatchObject({ code: "ACADEMIC_YEAR_NOT_FOUND", status: 404 });
  });

  it("keeps snapshot display and dimensions stable after current records change", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-CORE-0001",
    }, closedNow, client);
    expect(report.items[0]).toMatchObject({
      studentName: "Stable, Historical Student",
      collegeName: "Historic Alpha College",
      programName: "Alpha Program",
      yearLevel: 2,
    });
    expect(report.dimensions.colleges).toContainEqual({
      id: colleges.alpha, name: "Historic Alpha College",
    });
  });

  it("includes inactive students and marks a missing requirement unscheduled", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-CORE-0002",
    }, closedNow, client);
    expect(report.items).toEqual([expect.objectContaining({
      studentNumber: "RPT-CORE-0002",
      laboratoryStatus: "PENDING",
      physicalExamStatus: "UNSCHEDULED",
      overallStatus: "DID_NOT_COMPLY_BOTH",
    })]);
  });

  it("uses the snapshot and appointments from the selected cycle", async () => {
    const first = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-YEAR-0001",
    }, closedNow, client);
    const second = await getHistoricalComplianceReport({
      academicYearStart: String(NEXT_YEAR), search: "RPT-YEAR-0001",
    }, closedNow, client);
    expect(first.items[0]).toMatchObject({
      studentName: "Yearly, First Snapshot", collegeName: "Historic Alpha College",
      laboratoryStatus: "COMPLETED", physicalExamStatus: "UNSCHEDULED",
    });
    expect(second.items[0]).toMatchObject({
      studentName: "Yearly, Second Snapshot", collegeName: "Historic Beta College",
      laboratoryStatus: "UNSCHEDULED", physicalExamStatus: "COMPLETED",
    });
  });

  it("selects the published completed replacement over superseded and unpublished rows", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-CORE-0001",
    }, closedNow, client);
    expect(report.items[0]).toMatchObject({
      laboratoryAppointmentDate: "2088-09-15",
      laboratoryStatus: "COMPLETED",
      physicalExamStatus: "COMPLETED",
      overallStatus: "COMPLIED",
    });
  });

  it("applies snapshot dimensions, data quality, and overall noncompliance filters", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR),
      collegeId: colleges.beta,
      programId: programs.beta,
      yearLevel: "3",
      dataQuality: "MIGRATED_INCOMPLETE",
      overallStatus: "DID_NOT_COMPLY",
    }, closedNow, client);
    expect(report.items.map((row) => row.studentNumber)).toEqual(["RPT-CORE-0002"]);
  });

  it("keeps every historical college-program tuple when one program ID was reassigned", async () => {
    const unfiltered = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-TUPLE-", sort: "name_asc",
    }, closedNow, client);
    expect(unfiltered.dimensions.programs.filter((program) => program.id === programs.alpha))
      .toEqual(expect.arrayContaining([
        {
          id: programs.alpha,
          collegeId: colleges.alpha,
          code: "ALPHA",
          name: "Alpha Program",
        },
        {
          id: programs.alpha,
          collegeId: colleges.beta,
          code: "REASSIGNED",
          name: "Reassigned Program",
        },
      ]));

    const reassigned = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR),
      search: "RPT-TUPLE-",
      collegeId: colleges.beta,
      programId: programs.alpha,
    }, closedNow, client);
    expect(reassigned.items.map((row) => row.studentNumber)).toEqual(["RPT-TUPLE-BETA"]);
  });

  it.each([
    ["college_asc", ["RPT-SORT-B", "RPT-SORT-A", "RPT-SORT-D", "RPT-SORT-C"]],
    ["college_desc", ["RPT-SORT-C", "RPT-SORT-D", "RPT-SORT-A", "RPT-SORT-B"]],
    ["program_asc", ["RPT-SORT-D", "RPT-SORT-B", "RPT-SORT-C", "RPT-SORT-A"]],
    ["program_desc", ["RPT-SORT-A", "RPT-SORT-C", "RPT-SORT-B", "RPT-SORT-D"]],
    ["year_asc", ["RPT-SORT-D", "RPT-SORT-C", "RPT-SORT-A", "RPT-SORT-B"]],
    ["year_desc", ["RPT-SORT-B", "RPT-SORT-A", "RPT-SORT-C", "RPT-SORT-D"]],
    ["name_asc", ["RPT-SORT-B", "RPT-SORT-A", "RPT-SORT-D", "RPT-SORT-C"]],
    ["name_desc", ["RPT-SORT-C", "RPT-SORT-D", "RPT-SORT-A", "RPT-SORT-B"]],
    ["attention_first", ["RPT-SORT-B", "RPT-SORT-C", "RPT-SORT-A", "RPT-SORT-D"]],
    ["completed_first", ["RPT-SORT-A", "RPT-SORT-D", "RPT-SORT-B", "RPT-SORT-C"]],
  ] as const)("returns deterministic %s ordering", async (sort, expected) => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-SORT-", sort,
    }, closedNow, client);
    expect(report.items.map((row) => row.studentNumber)).toEqual(expected);
  });

  it("reconciles summary and every breakdown with the filtered details", async () => {
    const report = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-SORT-",
    }, closedNow, client);
    expect(report.total).toBe(4);
    expect(report.summary).toMatchObject({
      totalStudents: 4, fullyComplied: 2, didNotComply: 2,
      laboratoryIncomplete: 1, physicalExamIncomplete: 2, bothIncomplete: 1,
    });
    expect(report.items).toHaveLength(4);
    for (const groups of Object.values(report.breakdowns)) {
      expect(groups.reduce((total, group) => total + group.totalStudents, 0)).toBe(4);
      expect(groups.reduce((total, group) => total + group.fullyComplied, 0)).toBe(2);
    }
    expect(report.dimensions.programs).toContainEqual({
      id: programs.beta, collegeId: colleges.beta, code: "BETA", name: "Beta Program",
    });
  });

  it("returns exactly 150 rows on page one and the remaining row on page two", async () => {
    const first = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-PAGE-", page: "1", sort: "name_asc",
    }, closedNow, client);
    const second = await getHistoricalComplianceReport({
      academicYearStart: String(YEAR), search: "RPT-PAGE-", page: "2", sort: "name_asc",
    }, closedNow, client);
    expect(first.total).toBe(151);
    expect(first.items).toHaveLength(150);
    expect(first.items.at(0)?.studentNumber).toBe("RPT-PAGE-0001");
    expect(first.items.at(-1)?.studentNumber).toBe("RPT-PAGE-0150");
    expect(second.items.map((row) => row.studentNumber)).toEqual(["RPT-PAGE-0151"]);
  });

  it("reuses the filtered deterministic report path for bounded unpaginated export", async () => {
    const exported = await getHistoricalComplianceExportData({
      academicYearStart: String(YEAR), search: "RPT-PAGE-", sort: "name_asc",
    }, { now: closedNow, maxRows: 151, client });
    expect(exported.items).toHaveLength(151);
    expect(exported.items.at(-1)?.studentNumber).toBe("RPT-PAGE-0151");
    await expect(getHistoricalComplianceExportData({
      academicYearStart: String(YEAR), search: "RPT-PAGE-",
    }, { now: closedNow, maxRows: 150, client })).rejects.toMatchObject({
      code: "REPORT_EXPORT_TOO_LARGE", status: 422,
    });
  });
});
