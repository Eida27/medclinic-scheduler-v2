// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "@/server/db/pool";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import { dashboardMetrics } from "@/server/repositories/tracking.repository";
import {
  cleanupTestFixtures,
  insertNumberedTestStudents,
  insertTestScheduleImportGroup,
  TEST_REFERENCE_IDS,
} from "@/test/integration-fixtures";

const studentNumberPattern = "TEST-DASH-%";
const counterStudentNumberPrefix = "TEST-DASH-COUNT-";
const counterStudentNumbers = Array.from(
  { length: 5 },
  (_, index) => `${counterStudentNumberPrefix}${String(index + 1).padStart(4, "0")}`,
);
const capacityStudentNumberPrefix = "TEST-DASH-CAP-";
const capacityStudentNumberPattern = `${capacityStudentNumberPrefix}%`;
const futureStudentNumberPrefix = "TEST-DASH-FUT-";
const futureStudentNumberPattern = `${futureStudentNumberPrefix}%`;
const batchNamePattern = "TEST dashboard metrics%";
const manilaToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const calendarYear = Number(manilaToday.slice(0, 4));
const currentYear = manilaToday.slice(5) >= "08-01" ? calendarYear : calendarYear - 1;
const futureYear = currentYear + 1;
const appointmentDate = `${currentYear}-10-01`;
const createdYears: number[] = [];
let dailyCapacity: number;

beforeAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern);
  const capacity = await pool.query<{ max_daily_capacity: number }>(
    `SELECT max_daily_capacity
       FROM clinic_capacity_settings
      WHERE clinic_id=$1 AND schedule_type='LABORATORY'`,
    [TEST_REFERENCE_IDS.laboratoryClinic],
  );
  await insertNumberedTestStudents(counterStudentNumberPrefix, counterStudentNumbers.length);
  dailyCapacity = Number(capacity.rows[0].max_daily_capacity);
  await insertNumberedTestStudents(capacityStudentNumberPrefix, dailyCapacity + 1);
  await insertNumberedTestStudents(futureStudentNumberPrefix, dailyCapacity + 4);
  for (const year of [currentYear, futureYear]) {
    const created = await pool.query(`INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
      VALUES ($1,make_date($1 + 1,7,31),$2,$2)
      ON CONFLICT (start_year) DO NOTHING RETURNING start_year`,
    [year, TEST_REFERENCE_IDS.adminUser]);
    if (created.rowCount) createdYears.push(year);
  }
  await transaction(async (client) => {
    const importId = await insertTestScheduleImportGroup(client, {
      name: "TEST dashboard metrics provenance", sourceFilename: `${randomUUID()}.csv`,
      academicYearStart: currentYear, importMode: "STANDARD", actor: TEST_REFERENCE_IDS.adminUser,
    });
    await client.query(`INSERT INTO student_academic_snapshots
      (student_number,academic_year_start,student_name,college_id,college_name,
       program_id,program_code,program_name,year_level,source_import_group_id)
      SELECT student_number,$3,first_name || ' ' || last_name,college_id,
             'College of Computer Studies',program_id,'BSIT','BSIT',year_level,$1
        FROM students WHERE student_number LIKE $2`, [importId, studentNumberPattern, currentYear]);
    const futureImportId = await insertTestScheduleImportGroup(client, {
      name: "TEST dashboard metrics future provenance", sourceFilename: `${randomUUID()}.csv`,
      academicYearStart: futureYear, importMode: "STANDARD", actor: TEST_REFERENCE_IDS.adminUser,
    });
    await client.query(`INSERT INTO student_academic_snapshots
      (student_number,academic_year_start,student_name,college_id,college_name,
       program_id,program_code,program_name,year_level,source_import_group_id)
      SELECT student_number,$3,first_name || ' ' || last_name,college_id,
             'College of Computer Studies',program_id,'BSIT','BSIT',year_level,$1
        FROM students WHERE student_number LIKE $2`, [futureImportId, futureStudentNumberPattern, futureYear]);
  });
});

afterAll(async () => {
  await cleanupTestFixtures(studentNumberPattern, batchNamePattern, "TEST dashboard metrics%");
  for (const year of createdYears) await pool.query("DELETE FROM academic_years WHERE start_year=$1", [year]);
  await pool.end();
});

describe("dashboard metrics publication boundaries", () => {
  it("excludes a prepared future cycle from operational appointment counts and capacity", async () => {
    const baseline = await dashboardMetrics();
    await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
      `INSERT INTO appointments
         (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
          schedule_cycle_start,scheduling_category,created_by,updated_by)
       SELECT $1,student_number,'LABORATORY',make_date($2,9,22),
              CASE WHEN RIGHT(student_number,4)::integer <= $3 THEN 'PENDING'
                   WHEN RIGHT(student_number,4)::integer = $3 + 1 THEN 'NO_SHOW'
                   WHEN RIGHT(student_number,4)::integer = $3 + 2 THEN 'RESCHEDULED'
                   ELSE 'PENDING' END,
              TRUE,$2,'REGULAR',$4,$4
         FROM students WHERE student_number LIKE $5
       RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, futureYear, dailyCapacity + 1,
        TEST_REFERENCE_IDS.adminUser, futureStudentNumberPattern],
      );
      await linkPublishedLaboratoryAppointments(client, inserted.rows.map((row) => row.id));
    });

    await expect(dashboardMetrics()).resolves.toMatchObject({
      pendingAppointments: baseline.pendingAppointments,
      completedPhysicalExams: baseline.completedPhysicalExams,
      completedLaboratory: baseline.completedLaboratory,
      finalizedLaboratoryDocuments: baseline.finalizedLaboratoryDocuments,
      noShows: baseline.noShows,
      rescheduled: baseline.rescheduled,
      capacityConflicts: baseline.capacityConflicts,
    });
  }, 60000);

  it("returns permanent delivery failures only when the administrator count is requested", async () => {
    const baseline = await dashboardMetrics({ includeEmailDeliveryIssues: true });
    await pool.query(
      `INSERT INTO email_outbox (
         student_number,to_email,subject,text_body,status,attempts,message_kind,last_attempt_status
       ) VALUES ($1,'masked@example.test','Failure','Safe body','PERMANENT_FAILURE',10,'SCHEDULE','PERMANENT_FAILURE')`,
      [counterStudentNumbers[0]],
    );
    await expect(dashboardMetrics()).resolves.not.toHaveProperty("actionableEmailDeliveryFailures");
    await expect(dashboardMetrics({ includeEmailDeliveryIssues: true })).resolves.toMatchObject({
      actionableEmailDeliveryFailures: baseline.actionableEmailDeliveryFailures! + 1,
    });
  });

  it("does not expose administrator-only unpublished batch state", async () => {
    await expect(dashboardMetrics()).resolves.not.toHaveProperty("unpublishedBatches");
  });

  it("excludes every unpublished appointment-derived counter", async () => {
    const baseline = await dashboardMetrics();
    await pool.query(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, schedule_cycle_start, scheduling_category, created_by, updated_by
       )
       SELECT clinic_id::uuid, student_number, schedule_type, $5::date,
              status, FALSE, $7, 'REGULAR', $6, $6
         FROM UNNEST(
           $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[]
         ) AS fixture(student_number, schedule_type, status, clinic_id)`,
      [
        counterStudentNumbers,
        ["LABORATORY", "LABORATORY", "LABORATORY", "PHYSICAL_EXAM", "LABORATORY"],
        ["PENDING", "NO_SHOW", "RESCHEDULED", "PENDING", "PENDING"],
        [
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.physicalExamClinic,
          TEST_REFERENCE_IDS.laboratoryClinic,
        ],
        `${currentYear}-10-02`,
        TEST_REFERENCE_IDS.adminUser,
        currentYear,
      ],
    );
    await expect(dashboardMetrics()).resolves.toMatchObject({
      pendingAppointments: baseline.pendingAppointments,
      completedPhysicalExams: baseline.completedPhysicalExams,
      completedLaboratory: baseline.completedLaboratory,
      noShows: baseline.noShows,
      rescheduled: baseline.rescheduled,
    });

    await transaction(async (client) => {
      const published = await client.query<{ id: string; schedule_type: string }>(
        `UPDATE appointments
          SET is_published=TRUE
        WHERE student_number = ANY($1::varchar[]) RETURNING id::text,schedule_type`,
        [counterStudentNumbers],
      );
      await linkPublishedLaboratoryAppointments(client, published.rows
        .filter((row) => row.schedule_type === "LABORATORY").map((row) => row.id));
    });

    await expect(dashboardMetrics()).resolves.toMatchObject({
      pendingAppointments: baseline.pendingAppointments + 3,
      completedPhysicalExams: baseline.completedPhysicalExams,
      completedLaboratory: baseline.completedLaboratory,
      noShows: baseline.noShows + 1,
      rescheduled: baseline.rescheduled + 1,
    });
  });

  it("counts over-capacity dates only after appointments are published", async () => {
    const baseline = (await dashboardMetrics()).capacityConflicts;
    await pool.query(
      `INSERT INTO appointments (
         clinic_id, student_number, schedule_type, appointment_date,
         status, is_published, schedule_cycle_start, scheduling_category, created_by, updated_by
       )
       SELECT $1, student_number, 'LABORATORY', $2::date,
              'DRAFT', FALSE, $5, 'REGULAR', $3, $3
         FROM students
        WHERE student_number LIKE $4`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        appointmentDate,
        TEST_REFERENCE_IDS.adminUser,
        capacityStudentNumberPattern,
        currentYear,
      ],
    );

    await expect(dashboardMetrics()).resolves.toMatchObject({
      capacityConflicts: baseline,
    });

    await transaction(async (client) => {
      const published = await client.query<{ id: string }>(
        `UPDATE appointments
          SET status='PENDING', is_published=TRUE
        WHERE student_number LIKE $1 RETURNING id::text`,
        [capacityStudentNumberPattern],
      );
      await linkPublishedLaboratoryAppointments(client, published.rows.map((row) => row.id));
    });

    await expect(dashboardMetrics()).resolves.toMatchObject({
      capacityConflicts: baseline + 1,
    });
  });
});
