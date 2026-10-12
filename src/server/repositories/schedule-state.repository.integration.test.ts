// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { insertTestAcademicSnapshot, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { linkPublishedLaboratoryAppointments } from "@/server/laboratory/laboratory-checklist.repository";
import {
  buildCurrentStateNotification,
  fingerprintScheduleState,
} from "@/server/schedule/schedule-notifications";
import { loadAuthoritativeScheduleState } from "./schedule-state.repository";

describe("authoritative schedule-state repository", () => {
  it.each([
    [4, "OJT", true], [4, "REGULAR", false], [4, "TOUR", false], [3, "OJT", false], [1, "REGULAR", false],
  ] as const)("uses the linked saved cohort for year %s category %s", async (year, category, eligible) => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const studentNumber = `SCH-XRAY-${category}-${year}`;
      await client.query(`INSERT INTO students
        (student_number,first_name,last_name,college_id,program_id,year_level)
        VALUES ($1,'Saved','Cohort',$2,$3,$4)`,
      [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, year]);
      await client.query(`INSERT INTO academic_years(start_year,closing_date,created_by,updated_by)
        VALUES (2092,'2093-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING`, [TEST_REFERENCE_IDS.adminUser]);
      await insertTestAcademicSnapshot(client, { studentNumber, academicYearStart: 2092,
        importName: `SCH-XRAY ${studentNumber}`, actor: TEST_REFERENCE_IDS.adminUser });
      const pairId = randomUUID();
      const rows = (await client.query<{ id: string; schedule_type: string }>(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category)
        VALUES ($1,$3,'LABORATORY','2092-08-20','PENDING',TRUE,$4,2092,$5),
               ($2,$3,'PHYSICAL_EXAM','2092-09-03','PENDING',TRUE,$4,2092,$5)
        RETURNING id::text,schedule_type`,
      [TEST_REFERENCE_IDS.laboratoryClinic, TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, pairId, category])).rows;
      const labId = rows.find((row) => row.schedule_type === "LABORATORY")!.id;
      const peId = rows.find((row) => row.schedule_type === "PHYSICAL_EXAM")!.id;
      // Missing context remains usable during publication, before the caller establishes the link.
      const beforeLink = await loadAuthoritativeScheduleState(client, studentNumber);
      expect(beforeLink?.laboratory?.id).toBe(labId);
      expect(beforeLink).not.toHaveProperty("externalXraySchedule");
      await linkPublishedLaboratoryAppointments(client, [labId]);
      const saved = await loadAuthoritativeScheduleState(client, studentNumber);
      const detail = { anchorLaboratoryAppointmentId: labId, laboratoryDate: "2092-08-20",
        xrayDate: "2092-08-13", provider: "Iloilo Mission Hospital", offsetCalendarDays: 7 };
      if (eligible) expect(saved?.externalXraySchedule).toEqual(detail);
      else expect(saved).not.toHaveProperty("externalXraySchedule");
      await client.query("UPDATE students SET year_level=3 WHERE student_number=$1", [studentNumber]);
      const changedProfile = await loadAuthoritativeScheduleState(client, studentNumber);
      if (eligible) expect(changedProfile?.externalXraySchedule).toEqual(detail);
      else expect(changedProfile).not.toHaveProperty("externalXraySchedule");
      if (!eligible) return;

      await client.query("UPDATE appointments SET status='RESCHEDULED' WHERE id=$1", [labId]);
      const replacement = await client.query<{ id: string }>(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category,rescheduled_from)
        VALUES ($1,$2,'LABORATORY','2092-08-27','PENDING',TRUE,$3,2092,'OJT',$4) RETURNING id::text`,
      [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, pairId, labId]);
      const replacementId = replacement.rows[0].id;
      await linkPublishedLaboratoryAppointments(client, [replacementId]);
      const replacedDetail = { ...detail, anchorLaboratoryAppointmentId: replacementId,
        laboratoryDate: "2092-08-27", xrayDate: "2092-08-20" };
      expect((await loadAuthoritativeScheduleState(client, studentNumber))?.externalXraySchedule).toEqual(replacedDetail);

      await client.query("UPDATE appointments SET status='RESCHEDULED' WHERE id=$1", [peId]);
      await client.query(`INSERT INTO appointments
        (clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,scheduling_category,rescheduled_from)
        VALUES ($1,$2,'PHYSICAL_EXAM','2092-09-10','PENDING',TRUE,$3,2092,'OJT',$4)`,
      [TEST_REFERENCE_IDS.physicalExamClinic, studentNumber, pairId, peId]);
      expect((await loadAuthoritativeScheduleState(client, studentNumber))?.externalXraySchedule).toEqual(replacedDetail);
      await client.query("UPDATE appointments SET status='AWAITING_RESCHEDULE' WHERE id=$1", [replacementId]);
      expect((await loadAuthoritativeScheduleState(client, studentNumber))?.externalXraySchedule)
        .toEqual({ ...replacedDetail, laboratoryDate: null, xrayDate: null });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("loads current state and open Manual Resolution through the caller's transaction", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const studentNumber = "SCH-STATE-2092";
      await client.query(
        `INSERT INTO students (
           student_number,first_name,middle_name,last_name,college_id,program_id,year_level
         ) VALUES ($1,'Ana','Maria','Santos',$2,$3,1)`,
        [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program],
      );
      await client.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2092,'2093-07-31',$1,$1) ON CONFLICT (start_year) DO NOTHING`,
        [TEST_REFERENCE_IDS.adminUser],
      );
      const batch = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_batches (
           schedule_cycle_start,college_id,status,created_by,updated_by
         ) VALUES (2092,$1,'DRAFT',$2,$2) RETURNING id::text`,
        [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.adminUser],
      );
      const revision = await client.query<{ id: string }>(
        `INSERT INTO ovpsa_first_year_batch_revisions (
           batch_id,revision_number,status,laboratory_date,physical_exam_date,created_by,
           validation_snapshot,validated_by,validated_at,published_by,published_at
         ) VALUES ($1,1,'PUBLISHED','2092-09-05','2092-09-12',$2,
                   '{}',$2,clock_timestamp(),$2,clock_timestamp()) RETURNING id::text`,
        [batch.rows[0].id, TEST_REFERENCE_IDS.adminUser],
      );
      const reservations = await client.query<{ id: string; schedule_type: string }>(
        `INSERT INTO ovpsa_first_year_service_reservations (
           batch_id,revision_id,schedule_type,reservation_date,status,created_by
         ) VALUES
           ($1,$2,'LABORATORY','2092-09-05','ACTIVE',$3),
           ($1,$2,'PHYSICAL_EXAM','2092-09-12','ACTIVE',$3)
         RETURNING id::text,schedule_type`,
        [batch.rows[0].id, revision.rows[0].id, TEST_REFERENCE_IDS.adminUser],
      );
      const reservationByType = new Map(
        reservations.rows.map((row) => [row.schedule_type, row.id]),
      );
      const pairId = randomUUID();
      const appointments = await client.query<{ id: string; schedule_type: string }>(
        `INSERT INTO appointments (
           clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           schedule_pair_id,schedule_cycle_start,ovpsa_batch_id,ovpsa_revision_id,
           ovpsa_service_reservation_id
         ) VALUES
           ($1,$3,'LABORATORY','2092-09-05','AWAITING_RESCHEDULE',TRUE,$4,2092,$5,$6,$7),
           ($2,$3,'PHYSICAL_EXAM','2092-09-12','PENDING',TRUE,$4,2092,$5,$6,$8)
         RETURNING id::text,schedule_type`,
        [
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.physicalExamClinic,
          studentNumber,
          pairId,
          batch.rows[0].id,
          revision.rows[0].id,
          reservationByType.get("LABORATORY"),
          reservationByType.get("PHYSICAL_EXAM"),
        ],
      );
      const appointmentByType = new Map(
        appointments.rows.map((row) => [row.schedule_type, row.id]),
      );
      await client.query(
        `INSERT INTO appointments (
           clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           schedule_cycle_start
         ) VALUES ($1,$2,'LABORATORY','2092-09-30','CANCELLED',TRUE,2092)`,
        [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber],
      );
      const closure = await client.query<{ id: string }>(
        `INSERT INTO clinic_closure_groups (
           start_date,end_date,category,reason,created_by,creation_batch_id
         ) VALUES ('2092-09-05','2092-09-05','EMERGENCY_CLOSURE','TEST-SCHEDULE-STATE',
                   $1,$2) RETURNING id::text`,
        [TEST_REFERENCE_IDS.adminUser, randomUUID()],
      );
      const manualCaseIds = [
        "00000000-0000-4000-8000-000000000101",
        "00000000-0000-4000-8000-000000000102",
      ];
      await client.query(
        `INSERT INTO clinic_closure_manual_cases (
           id,student_number,closure_group_id,schedule_pair_id,schedule_cycle_start,
           affected_laboratory_appointment_id,reason_code,reason_message
         ) VALUES
           ($1,$3,$4,$5,2092,$6,'NO_REPLACEMENT_CAPACITY','No authorized replacement exists.'),
           ($2,$3,$4,$5,2092,$6,'NO_REPLACEMENT_CAPACITY','A second open case exists.')`,
        [
          ...manualCaseIds,
          studentNumber,
          closure.rows[0].id,
          pairId,
          appointmentByType.get("LABORATORY"),
        ],
      );

      await expect(loadAuthoritativeScheduleState(client, studentNumber)).resolves.toEqual({
        studentNumber,
        studentName: "Santos, Ana Maria",
        laboratory: {
          id: appointmentByType.get("LABORATORY"),
          scheduleType: "LABORATORY",
          status: "AWAITING_RESCHEDULE",
          date: null,
          affectedDate: "2092-09-05",
          location: "Iloilo Mission Hospital",
        },
        physicalExam: {
          id: appointmentByType.get("PHYSICAL_EXAM"),
          scheduleType: "PHYSICAL_EXAM",
          status: "PENDING",
          date: "2092-09-12",
          affectedDate: null,
          location: "CPU Clinic",
        },
        openManualResolutionIds: manualCaseIds,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps a lone service in only its own slot, email lines, and fingerprint input", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const laboratoryStudent = "SCH-STATE-LAB";
      const physicalStudent = "SCH-STATE-PE";
      await client.query(
        `INSERT INTO students (
           student_number,first_name,last_name,college_id,program_id,year_level
         ) VALUES
           ($1,'Laboratory','Only',$3,$4,2),
           ($2,'Physical','Only',$3,$4,2)`,
        [
          laboratoryStudent,
          physicalStudent,
          TEST_REFERENCE_IDS.college,
          TEST_REFERENCE_IDS.program,
        ],
      );
      await client.query(
        `INSERT INTO appointments (
           id,clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           schedule_cycle_start
         ) VALUES
           ('10000000-0000-4000-8000-000000000101',$1,$3,'LABORATORY','2092-10-01','PENDING',TRUE,2092),
           ('10000000-0000-4000-8000-000000000102',$2,$4,'PHYSICAL_EXAM','2092-10-08','PENDING',TRUE,2092)`,
        [
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.physicalExamClinic,
          laboratoryStudent,
          physicalStudent,
        ],
      );

      const laboratory = await loadAuthoritativeScheduleState(client, laboratoryStudent);
      const physical = await loadAuthoritativeScheduleState(client, physicalStudent);
      expect(laboratory).toMatchObject({
        laboratory: { id: "10000000-0000-4000-8000-000000000101" },
        physicalExam: null,
        openManualResolutionIds: [],
      });
      expect(physical).toMatchObject({
        laboratory: null,
        physicalExam: { id: "10000000-0000-4000-8000-000000000102" },
        openManualResolutionIds: [],
      });
      expect(laboratory).not.toHaveProperty("externalXraySchedule");
      expect(physical).not.toHaveProperty("externalXraySchedule");
      expect(fingerprintScheduleState(laboratory!)).toBe(
        "4d6d6a211d79178c9439b5785ba5f0880614ca7a2102e76fb8a722de11259ed3",
      );
      expect(fingerprintScheduleState(physical!)).toBe(
        "2d5dbc31e0f0264608a13553c2e06cb06baa9dfcee603ad4d091fb2e92c1e9db",
      );
      const laboratoryBody = buildCurrentStateNotification(laboratory!).emailTextBody;
      const physicalBody = buildCurrentStateNotification(physical!).emailTextBody;
      expect(laboratoryBody).toContain("Laboratory: 2092-10-01 at KABALAKA Clinic (Pending).");
      expect(laboratoryBody).not.toContain("Physical Examination:");
      expect(physicalBody).toContain("Physical Examination: 2092-10-08 at CPU Clinic (Pending).");
      expect(physicalBody).not.toContain("Laboratory:");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("returns null for an inactive or unknown student", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO students
        (student_number,first_name,last_name,college_id,program_id,is_active)
        VALUES ('SCH-STATE-INACTIVE','Inactive','Student',$1,$2,FALSE)`,
      [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program]);
      await expect(loadAuthoritativeScheduleState(client, "SCH-STATE-INACTIVE")).resolves.toBeNull();
      await expect(loadAuthoritativeScheduleState(client, "SCH-STATE-MISSING")).resolves.toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

afterAll(async () => {
  await pool.end();
});
