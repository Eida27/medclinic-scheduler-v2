// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  lockEligibleRegularPairs,
  lockEligibleRegularPhysicalExams,
  type DisplacementCandidate,
} from "@/server/repositories/priority-displacement.repository";
import {
  cleanupAndRestoreCapacitySettings,
  setupCapacityFixtureLock,
  teardownCapacityFixtureLock,
  type CapacityFixtureLock,
} from "@/test/capacity-fixture-lifecycle";
import { acceptAndScheduleImport } from "./schedule-imports.service";
import {
  priorityDisplacementScopes,
  publishDisplacedRegularReplacementsWithLockedScopes,
} from "./priority-displacement.service";

const studentPattern = "99-94%";
const importPattern = "%TEST-DISPLACE-UNIFIED%";
const ownedOvpsaBatches: string[] = [];
let capacityFixture: CapacityFixtureLock | null = null;
let ownsAcademicYear = false;

async function publishThroughLiveDisplacementPath(
  input: Parameters<typeof publishDisplacedRegularReplacementsWithLockedScopes>[0],
  client: Parameters<typeof publishDisplacedRegularReplacementsWithLockedScopes>[1],
) {
  await lockEffectiveAppointmentScopes(client, priorityDisplacementScopes(input.candidates));
  return publishDisplacedRegularReplacementsWithLockedScopes(input, client);
}

async function cleanup() {
  await pool.query(
    "DELETE FROM appointment_reschedule_events WHERE student_number LIKE $1",
    [studentPattern],
  );
  await pool.query(
    "DELETE FROM clinic_closure_manual_cases WHERE student_number LIKE $1",
    [studentPattern],
  );
  await cleanupTestFixtures(studentPattern, importPattern, importPattern);
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (SELECT id FROM clinic_closure_groups WHERE reason LIKE 'TEST-DISPLACE%')`,
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'TEST-DISPLACE%'");
  await pool.query("DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id=ANY($1::uuid[])", [ownedOvpsaBatches]);
  await pool.query("DELETE FROM ovpsa_first_year_batches WHERE id=ANY($1::uuid[])", [ownedOvpsaBatches]);
  ownedOvpsaBatches.length = 0;
  await pool.query("UPDATE academic_years SET closing_date='2028-07-31' WHERE start_year=2027");
}

async function fixture(studentNumber: string, firstYear = false) {
  await insertTestStudent({
    studentNumber,
    firstName: "Priority",
    lastName: "Displacement",
    yearLevel: 4,
  });
  const importGroup = await pool.query<{ id: string }>(
    `INSERT INTO schedule_import_groups (
       import_name,source_filename,total_rows,created_by,student_category,academic_year_start,
       import_mode,first_year_laboratory_date
     ) VALUES ($1,$1,1,$2,'REGULAR',2027,$3::varchar,CASE WHEN $3::varchar='FIRST_YEAR_OVPSA' THEN DATE '2027-08-30' END) RETURNING id::text`,
    [`${importPattern.replaceAll("%", "")}-${studentNumber}`, TEST_REFERENCE_IDS.adminUser, firstYear ? "FIRST_YEAR_OVPSA" : "STANDARD"],
  );
  const batches = await pool.query<{ id: string; clinicId: string }>(
    `INSERT INTO schedule_batches (
       clinic_id,batch_name,status,created_by,import_group_id
     ) VALUES
       ($1,$3,'PUBLISHED',$4,$5),
       ($2,$3,'PUBLISHED',$4,$5)
     RETURNING id::text,clinic_id::text AS "clinicId"`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      `${importPattern.replaceAll("%", "")}-${studentNumber}`,
      TEST_REFERENCE_IDS.adminUser,
      importGroup.rows[0].id,
    ],
  );
  const laboratoryBatchId = batches.rows.find(
    (batch) => batch.clinicId === TEST_REFERENCE_IDS.laboratoryClinic,
  )!.id;
  const physicalExamBatchId = batches.rows.find(
    (batch) => batch.clinicId === TEST_REFERENCE_IDS.physicalExamClinic,
  )!.id;
  const pairId = randomUUID();
  const appointments = await pool.query<{
    id: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    appointment_date: string;
  }>(
    `INSERT INTO appointments (
       clinic_id,student_number,schedule_type,appointment_date,status,is_published,
       schedule_pair_id,schedule_cycle_start,batch_id,created_by,updated_by
     ) VALUES
       ($1,$3,'LABORATORY','2027-08-30','RESCHEDULED',FALSE,$4,2027,$5,$7,$7),
       ($2,$3,'PHYSICAL_EXAM','2027-08-31','RESCHEDULED',FALSE,$4,2027,$6,$7,$7)
     RETURNING id::text,schedule_type,appointment_date::text`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      pairId,
      laboratoryBatchId,
      physicalExamBatchId,
      TEST_REFERENCE_IDS.adminUser,
    ],
  );
  const laboratory = appointments.rows.find((appointment) => appointment.schedule_type === "LABORATORY")!;
  const physicalExam = appointments.rows.find((appointment) => appointment.schedule_type === "PHYSICAL_EXAM")!;
  return { importGroupId: importGroup.rows[0].id, pairId, laboratory, physicalExam };
}

async function eligibleFixture(studentNumber: string, firstYear = false) {
  const created = await fixture(studentNumber, firstYear);
  await pool.query(
    `UPDATE appointments
        SET status='PENDING', is_published=TRUE
      WHERE id=ANY($1::uuid[])`,
    [[created.laboratory.id, created.physicalExam.id]],
  );
  return created;
}

async function attachSourceScheduleItems(appointmentIds: string[], sourceRowOrder: number) {
  await pool.query(
    `WITH inserted AS (
       INSERT INTO coordinator_schedule_items (
         batch_id,clinic_id,student_number,schedule_type,
         target_date,status,source_row_order,schedule_cycle_start
       )
       SELECT batch_id,clinic_id,student_number,schedule_type,
              appointment_date,'SCHEDULED',$2,schedule_cycle_start
         FROM appointments
        WHERE id=ANY($1::uuid[])
       RETURNING id,batch_id,student_number,schedule_type
     )
     UPDATE appointments appointment
        SET schedule_item_id=inserted.id
       FROM inserted
      WHERE appointment.id=ANY($1::uuid[])
        AND appointment.batch_id=inserted.batch_id
        AND appointment.student_number=inserted.student_number
        AND appointment.schedule_type=inserted.schedule_type`,
    [appointmentIds, sourceRowOrder],
  );
}

async function candidateFixture(input: {
  studentNumber: string;
  laboratoryDate: string;
  physicalExamDate: string;
  windowStart: string;
  windowEnd?: string;
  sourceRowOrder?: number;
  acceptedAt?: string;
}) {
  const created = await eligibleFixture(input.studentNumber);
  const acceptedAt = input.acceptedAt ?? "2028-03-20T00:00:00.000Z";
  const sourceRowOrder = input.sourceRowOrder ?? 7;
  await pool.query(
    `UPDATE appointments
        SET appointment_date=CASE schedule_type
              WHEN 'LABORATORY' THEN $2::date ELSE $3::date END,
            scheduling_category='REGULAR',scheduling_accepted_at=$4,
            scheduling_source_row_order=$5,scheduling_window_start=$6,
            scheduling_window_end=$7
      WHERE student_number=$1`,
    [
      input.studentNumber,
      input.laboratoryDate,
      input.physicalExamDate,
      acceptedAt,
      sourceRowOrder,
      input.windowStart,
      input.windowEnd ?? "2028-03-31",
    ],
  );
  return {
    created,
    candidate: {
      displacementType: "PAIR",
      studentNumber: input.studentNumber,
      schedulePairId: created.pairId,
      laboratoryAppointmentId: created.laboratory.id,
      laboratoryDate: input.laboratoryDate,
      physicalExamAppointmentId: created.physicalExam.id,
      physicalExamDate: input.physicalExamDate,
      schedulingCategory: "REGULAR",
      acceptedAt: new Date(acceptedAt),
      sourceRowOrder,
      schedulingWindowStart: input.windowStart,
      schedulingWindowEnd: input.windowEnd ?? "2028-03-31",
      scheduleCycleStart: 2027,
      scheduleCycleClosingDate: "2028-07-31",
    } satisfies DisplacementCandidate,
  };
}

async function addActiveDraftFile(appointmentId: string, studentNumber: string) {
  const submission = await pool.query<{ id: string }>(
    `INSERT INTO student_result_submissions (appointment_id,student_number,result_type)
     SELECT id,student_number,schedule_type FROM appointments WHERE id=$1
     RETURNING id::text`,
    [appointmentId],
  );
  await pool.query(
    `INSERT INTO student_result_files (
       submission_id,storage_key,original_filename,detected_mime_type,
       extension,byte_size,checksum_sha256
     ) VALUES ($1,$2,$3,'application/pdf','pdf',32,$4)`,
    [submission.rows[0].id, `priority/${studentNumber}.pdf`, `${studentNumber}.pdf`, "c".repeat(64)],
  );
}

async function insertUnifiedDate(date: string, reopened: boolean) {
  await pool.query(
    `WITH closure AS (
       INSERT INTO clinic_closure_groups (
         start_date,end_date,category,reason,created_by,creation_batch_id
       ) VALUES ($1,$1,'CLOSURE','TEST-DISPLACE unified block',$2,gen_random_uuid())
       RETURNING id
     )
     INSERT INTO clinic_unavailable_dates (
       closure_group_id,blocked_date,reopened_at,reopened_by,reopening_batch_id
     ) SELECT id,$1,
              CASE WHEN $3 THEN NOW() END,
              CASE WHEN $3 THEN $2::uuid END,
              CASE WHEN $3 THEN gen_random_uuid() END
         FROM closure`,
    [date, TEST_REFERENCE_IDS.adminUser, reopened],
  );
}

async function publish(studentNumber: string) {
  const created = await candidateFixture({
    studentNumber,
    laboratoryDate: "2027-08-30",
    physicalExamDate: "2027-08-31",
    windowStart: "2027-09-01",
    windowEnd: "2027-09-30",
    sourceRowOrder: 0,
    acceptedAt: "2027-07-01T00:00:00.000Z",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await publishThroughLiveDisplacementPath({
      candidates: [created.candidate],
      sourceImportGroupId: created.created.importGroupId,
      actorUserId: TEST_REFERENCE_IDS.adminUser,
    }, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  capacityFixture = await setupCapacityFixtureLock(pool, cleanup);
  const academicYear = await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES (2027,'2028-07-31',$1,$1)
     ON CONFLICT (start_year) DO NOTHING
     RETURNING start_year`,
    [TEST_REFERENCE_IDS.adminUser],
  );
  ownsAcademicYear = academicYear.rowCount === 1;
});
afterEach(async () => {
  if (!capacityFixture) return;
  await cleanupAndRestoreCapacitySettings(pool, capacityFixture.originalCapacities, cleanup);
  const residue = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM students WHERE student_number LIKE $1) AS students,
    (SELECT COUNT(*)::int FROM appointments WHERE student_number LIKE $1) AS appointments,
    (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE student_number LIKE $1) AS snapshots,
    (SELECT COUNT(*)::int FROM schedule_import_groups WHERE import_name LIKE $2) AS imports,
    (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number LIKE $1) AS events,
    (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number LIKE $1) AS notifications`,
    [studentPattern, importPattern]);
  expect(residue.rows).toEqual([{students: 0, appointments: 0, snapshots: 0, imports: 0, events: 0, notifications: 0}]);
});
afterAll(async () => {
  if (!capacityFixture) return;
  if (ownsAcademicYear) {
    await cleanup();
    await pool.query("DELETE FROM academic_years WHERE start_year=2027");
  }
  await teardownCapacityFixtureLock(pool, capacityFixture, cleanup);
});


async function setCapacity(closingDate = "2028-07-31", capacity = 1) {
  await pool.query("UPDATE clinic_capacity_settings SET max_daily_capacity=$1,safe_daily_capacity=$1", [capacity]);
  await pool.query("UPDATE academic_years SET closing_date=$1 WHERE start_year=2027", [closingDate]);
}

async function importPriority(count = 1) {
  const contents = [
    "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
    ...Array.from({ length: count }, (_, i) => `99-9490-${String(i).padStart(2, "0")},Incoming,Priority,Maria,,College of Computer Studies,BSIT,4,2003-05-06`),
  ].join("\n");
  return acceptAndScheduleImport({
    fileName: "TEST-DISPLACE-UNIFIED.csv", fileSize: Buffer.byteLength(contents), contents,
    studentCategory: "OJT", academicYearStart: 2027, preferredMonth: 8,
  }, { userId: TEST_REFERENCE_IDS.adminUser, role: "ADMIN", fullName: "System Admin", email: "admin@medclinic.local" });
}

async function attachOvpsa(appointmentId: string) {
  const batch = await pool.query<{ id: string }>(`INSERT INTO ovpsa_first_year_batches
    (schedule_cycle_start,college_id,created_by,updated_by) VALUES (2027,$1,$2,$2) RETURNING id`,
    [TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.adminUser]);
  ownedOvpsaBatches.push(batch.rows[0].id);
  const revision = await pool.query<{ id: string }>(`INSERT INTO ovpsa_first_year_batch_revisions
    (batch_id,revision_number,laboratory_date,physical_exam_date,created_by)
    VALUES ($1,1,'2027-08-30','2027-09-06',$2) RETURNING id`, [batch.rows[0].id, TEST_REFERENCE_IDS.adminUser]);
  const reservation = await pool.query<{ id: string }>(`INSERT INTO ovpsa_first_year_service_reservations
    (batch_id,revision_id,schedule_type,reservation_date,created_by)
    SELECT $1,$2,schedule_type,appointment_date,$3 FROM appointments WHERE id=$4 RETURNING id`,
    [batch.rows[0].id, revision.rows[0].id, TEST_REFERENCE_IDS.adminUser, appointmentId]);
  await pool.query(`UPDATE appointments SET ovpsa_batch_id=$2,ovpsa_revision_id=$3,
    ovpsa_service_reservation_id=$4 WHERE id=$1`, [appointmentId, batch.rows[0].id, revision.rows[0].id, reservation.rows[0].id]);
  return reservation.rows[0].id;
}

describe("priority displacement with the unified closure calendar", () => {
  it.each(["FIRST_YEAR", "LABORATORY", "PHYSICAL_EXAM"].flatMap(protection =>
    ["PAIR", "PHYSICAL_EXAM_ONLY"].map(selector => ({ protection, selector })),
  ))("excludes $protection ownership from $selector victim selection", async ({ protection, selector }) => {
    const regular = await eligibleFixture("99-9420-00");
    const protectedPair = await eligibleFixture("99-9421-00", protection === "FIRST_YEAR");
    const reservationId = protection === "FIRST_YEAR" ? null : await attachOvpsa(
      protection === "LABORATORY" ? protectedPair.laboratory.id : protectedPair.physicalExam.id);
    const before = (await pool.query("SELECT * FROM appointments WHERE student_number='99-9421-00' ORDER BY id")).rows;
    {
      const select = selector === "PAIR" ? lockEligibleRegularPairs : lockEligibleRegularPhysicalExams;
      const candidates = await transaction(client => select(client, {
        scheduleCycleStart: 2027, windowStart: "2027-08-01", windowEnd: "2027-09-30", limit: 10,
      }));
      expect(candidates.map(candidate => candidate.schedulePairId)).toEqual([regular.pairId]);
    }
    expect((await pool.query("SELECT * FROM appointments WHERE student_number='99-9421-00' ORDER BY id")).rows).toEqual(before);
    if (reservationId) expect((await pool.query("SELECT status FROM ovpsa_first_year_service_reservations WHERE id=$1", [reservationId])).rows).toEqual([{ status: "ACTIVE" }]);
  });

  it.each([false, true].flatMap(reverse => [false, true].map(pairOlder => ({ reverse, pairOlder }))))(
    "recovers mixed victims by global FCFS with reversed=$reverse and pairOlder=$pairOlder", async ({ reverse, pairOlder }) => {
      await setCapacity();
      const older = await candidateFixture({
        studentNumber: "99-9422-00",
        laboratoryDate: "2028-07-27",
        physicalExamDate: "2028-07-28",
        windowStart: "2028-07-31",
        acceptedAt: "2027-08-01T00:00:00Z",
      });
      const later = await candidateFixture({
        studentNumber: "99-9423-00",
        laboratoryDate: "2028-07-26",
        physicalExamDate: "2028-07-27",
        windowStart: "2028-07-28",
        acceptedAt: "2027-08-02T00:00:00Z",
      });
      await pool.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [older.created.laboratory.id]);
      if (pairOlder) {
        later.candidate.acceptedAt = new Date("2027-07-31T00:00:00Z");
        await pool.query("UPDATE appointments SET scheduling_accepted_at=$2 WHERE student_number=$1", [later.candidate.studentNumber, later.candidate.acceptedAt]);
      }
      const winner = pairOlder ? later : older;
      const loser = pairOlder ? older : later;
      const candidates: DisplacementCandidate[] = [{ ...older.candidate, displacementType: "PHYSICAL_EXAM_ONLY" }, later.candidate];
      if (reverse) candidates.reverse();
      const replacements = await transaction(client => publishThroughLiveDisplacementPath({ candidates, sourceImportGroupId: later.created.importGroupId, actorUserId: TEST_REFERENCE_IDS.adminUser }, client));
      expect(replacements.map(row => row.studentNumber)).toEqual([winner.candidate.studentNumber]);
      expect((await pool.query("SELECT status FROM appointments WHERE id=$1", [older.created.laboratory.id])).rows).toEqual([{ status: "COMPLETED" }]);
      expect((await pool.query("SELECT student_number,reason_code FROM clinic_closure_manual_cases WHERE student_number LIKE $1", [studentPattern])).rows).toEqual([{ student_number: loser.candidate.studentNumber, reason_code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE" }]);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM student_portal_notifications WHERE student_number LIKE $1", [studentPattern])).rows).toEqual([{ count: 2 }]);
    });

  it.each([1, 2])("considers displacement for %s incoming students in a full or partially full cycle", async (count) => {
    await setCapacity("2027-08-04");
    const regular = await candidateFixture({
      studentNumber: "99-9424-00",
      laboratoryDate: "2027-08-02",
      physicalExamDate: "2027-08-03",
      windowStart: "2027-08-02",
    });
    if (count === 1) await setCapacity("2027-08-03");
    const result = await importPriority(count);
    expect(result).toMatchObject({ status: "PUBLISHED", displacementTotal: 1 });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM appointments WHERE student_number LIKE '99-9490-%'")).rows).toEqual([{ count: count * 2 }]);
    expect((await pool.query("SELECT reason_code FROM clinic_closure_manual_cases WHERE student_number=$1", [regular.candidate.studentNumber])).rows).toEqual([{ reason_code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE" }]);
  });

  it("preserves an ineffective blocked victim without displacement history or notices", async () => {
    await setCapacity();
    const regular = await candidateFixture({
      studentNumber: "99-9425-00",
      laboratoryDate: "2027-08-30",
      physicalExamDate: "2027-08-31",
      windowStart: "2027-08-01",
    });
    for (let day = 1;day <= 31;day++) await insertUnifiedDate(`2027-08-${String(day).padStart(2, "0")}`, false);
    const before = (await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [regular.candidate.studentNumber])).rows;
    expect(await importPriority()).toMatchObject({ status: "PUBLISHED", displacementTotal: 0, overflow: { pairCountBeyondPreferredWindow: 1 } });
    expect((await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [regular.candidate.studentNumber])).rows).toEqual(before);
    expect((await pool.query(`SELECT (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number=$1) AS events,
      (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=$1) AS notifications`, [regular.candidate.studentNumber])).rows).toEqual([{ events: 0, notifications: 0 }]);
  });

  it("reports PE-only overflow when an exclusive reservation prevents preferred-window placement", async () => {
    await setCapacity();
    const protectedPair = await candidateFixture({
      studentNumber: "99-9437-00",
      laboratoryDate: "2027-08-27",
      physicalExamDate: "2027-08-31",
      windowStart: "2027-08-01",
    });
    const reservationId = await attachOvpsa(protectedPair.created.physicalExam.id);
    for (let day = 1;day <= 29;day++) await insertUnifiedDate(`2027-08-${String(day).padStart(2, "0")}`, false);
    const before = (await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [protectedPair.candidate.studentNumber])).rows;
    expect(await importPriority()).toMatchObject({ displacementTotal: 0, overflow: { pairCountBeyondPreferredWindow: 1, unscheduledStudentCount: 0 } });
    expect((await pool.query("SELECT appointment_date::text FROM appointments WHERE student_number='99-9490-00' ORDER BY schedule_type")).rows).toEqual([{ appointment_date: "2027-08-30" }, { appointment_date: "2027-09-01" }]);
    expect((await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [protectedPair.candidate.studentNumber])).rows).toEqual(before);
    expect((await pool.query("SELECT status FROM ovpsa_first_year_service_reservations WHERE id=$1", [reservationId])).rows).toEqual([{ status: "ACTIVE" }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM student_portal_notifications WHERE student_number=$1", [protectedPair.candidate.studentNumber])).rows).toEqual([{ count: 0 }]);
  });

  it("combines complementary releases and preserves a redundant Laboratory", async () => {
    await setCapacity();
    const labVictim = await candidateFixture({
      studentNumber: "99-9430-00",
      laboratoryDate: "2027-08-30",
      physicalExamDate: "2027-09-01",
      windowStart: "2027-08-01",
      acceptedAt: "2027-07-01T00:00:00Z",
    });
    const peVictim = await candidateFixture({
      studentNumber: "99-9431-00",
      laboratoryDate: "2027-08-27",
      physicalExamDate: "2027-08-31",
      windowStart: "2027-08-01",
      acceptedAt: "2027-07-02T00:00:00Z",
    });
    for (let day = 1;day <= 29;day++) await insertUnifiedDate(`2027-08-${String(day).padStart(2, "0")}`, false);
    const preservedLab = (await pool.query("SELECT * FROM appointments WHERE id=$1", [peVictim.created.laboratory.id])).rows;
    expect(await importPriority()).toMatchObject({ displacementTotal: 2, overflow: { pairCountBeyondPreferredWindow: 0 } });
    expect((await pool.query("SELECT appointment_date::text FROM appointments WHERE student_number='99-9490-00' ORDER BY schedule_type")).rows).toEqual([{ appointment_date: "2027-08-30" }, { appointment_date: "2027-08-31" }]);
    expect((await pool.query("SELECT * FROM appointments WHERE id=$1", [peVictim.created.laboratory.id])).rows).toEqual(preservedLab);
    expect((await pool.query("SELECT student_number,strategy FROM appointment_reschedule_events WHERE student_number LIKE $1 ORDER BY student_number", [studentPattern])).rows).toEqual([
      { student_number: labVictim.candidate.studentNumber, strategy: "MOVE_COMPLETE_PAIR" },
      { student_number: peVictim.candidate.studentNumber, strategy: "MOVE_PHYSICAL_ONLY" },
    ]);
    const duplicates = await pool.query(`SELECT student_number,schedule_type FROM appointments
      WHERE student_number LIKE $1 AND status IN ('PENDING','COMPLETED') GROUP BY student_number,schedule_type HAVING COUNT(*)>1`, [studentPattern]);
    expect(duplicates.rows).toEqual([]);
  });

  it("prunes an older redundant victim and retains the later accepted pair", async () => {
    await setCapacity("2028-07-31", 2);
    const older = await candidateFixture({
      studentNumber: "99-9432-00",
      laboratoryDate: "2027-08-30",
      physicalExamDate: "2027-08-31",
      windowStart: "2027-08-01",
      acceptedAt: "2027-07-01T00:00:00Z",
    });
    const later = await candidateFixture({
      studentNumber: "99-9433-00",
      laboratoryDate: "2027-08-30",
      physicalExamDate: "2027-08-31",
      windowStart: "2027-08-01",
      acceptedAt: "2027-07-02T00:00:00Z",
    });
    for (let day = 1;day <= 29;day++) await insertUnifiedDate(`2027-08-${String(day).padStart(2, "0")}`, false);
    const before = (await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [older.candidate.studentNumber])).rows;
    expect(await importPriority()).toMatchObject({ displacementTotal: 1, overflow: { pairCountBeyondPreferredWindow: 0 } });
    expect((await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [older.candidate.studentNumber])).rows).toEqual(before);
    expect((await pool.query("SELECT student_number FROM appointment_reschedule_events WHERE student_number LIKE $1", [studentPattern])).rows).toEqual([{ student_number: later.candidate.studentNumber }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM student_portal_notifications WHERE student_number=$1", [older.candidate.studentNumber])).rows).toEqual([{ count: 0 }]);
  });

  it("searches the remaining cycle for unassigned demand even after the preferred month", async () => {
    await setCapacity("2027-09-02");
    await candidateFixture({ studentNumber: "99-9434-00", laboratoryDate: "2027-09-01", physicalExamDate: "2027-09-02", windowStart: "2027-09-01" });
    for (let day = 1;day <= 31;day++) await insertUnifiedDate(`2027-08-${String(day).padStart(2, "0")}`, false);
    expect(await importPriority()).toMatchObject({ displacementTotal: 1, overflow: { pairCountBeyondPreferredWindow: 1, unscheduledStudentCount: 0 } });
    expect((await pool.query("SELECT reason_code FROM clinic_closure_manual_cases WHERE student_number='99-9434-00'")).rows).toEqual([{ reason_code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE" }]);
  });

  it("relieves unassigned PE-only pressure while preserving a completed Laboratory", async () => {
    await setCapacity("2027-08-03");
    const victim = await candidateFixture({
      studentNumber: "99-9435-00",
      laboratoryDate: "2027-07-30",
      physicalExamDate: "2027-08-03",
      windowStart: "2027-08-01",
    });
    await pool.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [victim.created.laboratory.id]);
    const before = (await pool.query("SELECT * FROM appointments WHERE id=$1", [victim.created.laboratory.id])).rows;
    expect(await importPriority()).toMatchObject({ displacementTotal: 1 });
    expect((await pool.query("SELECT * FROM appointments WHERE id=$1", [victim.created.laboratory.id])).rows).toEqual(before);
    expect((await pool.query("SELECT strategy,outcome FROM appointment_reschedule_events WHERE student_number=$1", [victim.candidate.studentNumber])).rows).toEqual([{ strategy: "MOVE_PHYSICAL_ONLY", outcome: "REPLACED" }]);
  });

  it("rolls back actual incoming student updates, snapshots and publication when protected capacity cannot fit the entire import", async () => {
    await setCapacity("2027-08-03");
    const protectedPair = await candidateFixture({
      studentNumber: "99-9436-00",
      laboratoryDate: "2027-08-02",
      physicalExamDate: "2027-08-03",
      windowStart: "2027-08-01",
    });
    const reservationId = await attachOvpsa(protectedPair.created.physicalExam.id);
    await insertTestStudent({ studentNumber: "99-9490-00", firstName: "Unchanged", lastName: "Before", yearLevel: 4 });
    const before = (await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [protectedPair.candidate.studentNumber])).rows;
    await expect(importPriority(2)).rejects.toMatchObject({ code: "SCHEDULE_CAPACITY_EXHAUSTED" });
    expect((await pool.query("SELECT * FROM appointments WHERE student_number=$1 ORDER BY id", [protectedPair.candidate.studentNumber])).rows).toEqual(before);
    expect((await pool.query("SELECT first_name FROM students WHERE student_number LIKE '99-9490-%'")).rows).toEqual([{ first_name: "Unchanged" }]);
    expect((await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM appointments WHERE student_number LIKE '99-9490-%') AS appointments,
      (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE student_number LIKE '99-9490-%') AS snapshots,
      (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename='TEST-DISPLACE-UNIFIED.csv') AS imports,
      (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number LIKE $1) AS events,
      (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number LIKE $1) AS notifications`, [studentPattern])).rows).toEqual([{ appointments: 0, snapshots: 0, imports: 0, events: 0, notifications: 0 }]);
    expect((await pool.query("SELECT status FROM ovpsa_first_year_service_reservations WHERE id=$1", [reservationId])).rows).toEqual([{ status: "ACTIVE" }]);
  });

  it("uses persisted scheduling lineage before deterministic legacy fallbacks", async () => {
    const fixture = await candidateFixture({
      studentNumber: "99-9405-05",
      laboratoryDate: "2027-08-30",
      physicalExamDate: "2027-08-31",
      windowStart: "2027-08-15",
      sourceRowOrder: 17,
      acceptedAt: "2027-08-08T01:02:03.000Z",
    });

    const candidates = await transaction((client) => lockEligibleRegularPairs(client, {
      scheduleCycleStart: 2027,
      windowStart: "2027-08-01",
      windowEnd: "2027-09-30",
      limit: 1,
    }));

    expect(candidates).toEqual([expect.objectContaining({
      schedulePairId: fixture.created.pairId,
      schedulingCategory: "REGULAR",
      acceptedAt: new Date("2027-08-08T01:02:03.000Z"),
      sourceRowOrder: 17,
      schedulingWindowStart: "2027-08-15",
      schedulingWindowEnd: "2028-03-31",
      scheduleCycleClosingDate: "2028-07-31",
    })]);
  });

  it("keeps a successful Regular replacement eligible for later priority displacement", async () => {
    const original = await candidateFixture({
      studentNumber: "99-9411-11",
      laboratoryDate: "2027-08-30",
      physicalExamDate: "2027-08-31",
      windowStart: "2027-09-01",
      windowEnd: "2027-09-30",
      sourceRowOrder: 11,
      acceptedAt: "2027-08-20T00:00:00.000Z",
    });
    await attachSourceScheduleItems([
      original.created.laboratory.id,
      original.created.physicalExam.id,
    ], 11);
    await transaction((client) => publishThroughLiveDisplacementPath({
      candidates: [original.candidate],
      sourceImportGroupId: original.created.importGroupId,
      actorUserId: TEST_REFERENCE_IDS.adminUser,
    }, client));

    const laterCandidates = await transaction((client) => lockEligibleRegularPairs(client, {
      scheduleCycleStart: 2027,
      windowStart: "2027-09-01",
      windowEnd: "2027-09-30",
      limit: 1,
    }));

    expect(laterCandidates).toEqual([expect.objectContaining({
      studentNumber: "99-9411-11",
      schedulePairId: original.created.pairId,
      schedulingCategory: "REGULAR",
      acceptedAt: new Date("2027-08-20T00:00:00.000Z"),
      sourceRowOrder: 11,
    })]);
    expect(laterCandidates[0].laboratoryAppointmentId).not.toBe(original.created.laboratory.id);
    expect(laterCandidates[0].physicalExamAppointmentId).not.toBe(original.created.physicalExam.id);
    const replacementLineage = await pool.query(
      `SELECT batch_id::text,schedule_item_id::text
         FROM appointments
        WHERE student_number='99-9411-11' AND rescheduled_from IS NOT NULL
        ORDER BY schedule_type`,
    );
    expect(replacementLineage.rows).toEqual([
      { batch_id: expect.any(String), schedule_item_id: null },
      { batch_id: expect.any(String), schedule_item_id: null },
    ]);
  });

  it("excludes a pair when either appointment has an active draft result file", async () => {
    const created = await eligibleFixture("99-9403-03");
    await addActiveDraftFile(created.laboratory.id, "99-9403-03");

    await expect(transaction((client) => lockEligibleRegularPairs(client, {
      scheduleCycleStart: 2027,
      windowStart: "2027-08-01",
      windowEnd: "2027-09-30",
      limit: 10,
    }))).resolves.toEqual([]);
  });

  it("excludes a Physical-only candidate with an active draft result file", async () => {
    const created = await eligibleFixture("99-9404-04");
    await addActiveDraftFile(created.physicalExam.id, "99-9404-04");

    await expect(transaction((client) => lockEligibleRegularPhysicalExams(client, {
      scheduleCycleStart: 2027,
      windowStart: "2027-08-01",
      windowEnd: "2027-09-30",
      limit: 10,
    }))).resolves.toEqual([]);
  });

  it("skips the same active blocked dates for both replacement services", async () => {
    await insertUnifiedDate("2027-09-01", false);
    await insertUnifiedDate("2027-09-02", false);
    await expect(publish("99-9401-01")).resolves.toEqual([
      expect.objectContaining({ laboratoryDate: "2027-09-03", physicalExamDate: "2027-09-06" }),
    ]);
  });

  it("allows a reopened date to be allocated again", async () => {
    await insertUnifiedDate("2027-09-01", true);
    await expect(publish("99-9402-02")).resolves.toEqual([
      expect.objectContaining({ laboratoryDate: "2027-09-01", physicalExamDate: "2027-09-02" }),
    ]);
    const notification = await pool.query(
      `SELECT notification_type,event_key,metadata->>'sourceType' AS source_type,
              metadata->>'sourceId' AS source_id,message
         FROM student_portal_notifications WHERE student_number='99-9402-02'`,
    );
    expect(notification.rows).toEqual([{
      notification_type: "SCHEDULE_PRIORITY_DISPLACEMENT",
      event_key: expect.stringMatching(/^schedule:event:[0-9a-f-]+:99-9402-02$/),
      source_type: "APPOINTMENT_RESCHEDULE_EVENT",
      source_id: expect.any(String),
      message: expect.stringContaining("2027-09-01 at KABALAKA Clinic"),
    }]);
  });

  it("keeps a Physical Examination-only replacement after the persisted Laboratory date", async () => {
    const created = await candidateFixture({
      studentNumber: "99-9408-08",
      laboratoryDate: "2027-09-03",
      physicalExamDate: "2027-09-07",
      windowStart: "2027-09-01",
      windowEnd: "2028-03-31",
      sourceRowOrder: 8,
      acceptedAt: "2027-08-20T00:00:00.000Z",
    });
    const candidate: DisplacementCandidate = {
      ...created.candidate,
      displacementType: "PHYSICAL_EXAM_ONLY",
    };

    const replacements = await transaction((client) => publishThroughLiveDisplacementPath({
      candidates: [candidate],
      sourceImportGroupId: created.created.importGroupId,
      actorUserId: TEST_REFERENCE_IDS.adminUser,
    }, client));

    expect(replacements).toEqual([expect.objectContaining({
      schedulePairId: created.created.pairId,
      laboratoryDate: "2027-09-03",
      physicalExamDate: "2027-09-06",
    })]);
    const appointments = await pool.query(
      `SELECT schedule_type,status,appointment_date::text,rescheduled_from::text,
              scheduling_source_row_order,schedule_pair_id::text
         FROM appointments
        WHERE student_number='99-9408-08'
        ORDER BY schedule_type,appointment_date`,
    );
    expect(appointments.rows).toEqual([
      expect.objectContaining({
        schedule_type: "LABORATORY",
        status: "PENDING",
        appointment_date: "2027-09-03",
        rescheduled_from: null,
      }),
      expect.objectContaining({
        schedule_type: "PHYSICAL_EXAM",
        status: "PENDING",
        appointment_date: "2027-09-06",
        rescheduled_from: created.created.physicalExam.id,
        scheduling_source_row_order: 8,
        schedule_pair_id: created.created.pairId,
      }),
      expect.objectContaining({
        schedule_type: "PHYSICAL_EXAM",
        status: "RESCHEDULED",
        appointment_date: "2027-09-07",
        rescheduled_from: null,
      }),
    ]);
  });

  it("rolls back incoming publication and fallback state as one transaction", async () => {
    const displaced = await candidateFixture({
      studentNumber: "99-9409-09",
      laboratoryDate: "2028-03-28",
      physicalExamDate: "2028-03-29",
      windowStart: "2028-07-31",
      sourceRowOrder: 9,
      acceptedAt: "2028-03-21T00:00:00.000Z",
    });
    const incomingStudent = "99-9410-10";
    await insertTestStudent({
      studentNumber: incomingStudent,
      firstName: "Incoming",
      lastName: "Priority",
      yearLevel: 4,
    });

    await expect(transaction(async (client) => {
      const incomingPairId = randomUUID();
      await client.query(
        `INSERT INTO appointments (
           clinic_id,student_number,schedule_type,appointment_date,status,is_published,
           schedule_pair_id,schedule_cycle_start,created_by,updated_by
         ) VALUES
           ($1,$3,'LABORATORY','2028-03-28','PENDING',TRUE,$4,2027,$5,$5),
           ($2,$3,'PHYSICAL_EXAM','2028-03-29','PENDING',TRUE,$4,2027,$5,$5)`,
        [
          TEST_REFERENCE_IDS.laboratoryClinic,
          TEST_REFERENCE_IDS.physicalExamClinic,
          incomingStudent,
          incomingPairId,
          TEST_REFERENCE_IDS.adminUser,
        ],
      );
      await publishThroughLiveDisplacementPath({
        candidates: [displaced.candidate],
        sourceImportGroupId: displaced.created.importGroupId,
        actorUserId: TEST_REFERENCE_IDS.adminUser,
      }, client);
      throw new Error("TEST-DISPLACE force publication rollback");
    })).rejects.toThrow("TEST-DISPLACE force publication rollback");

    const state = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM appointments WHERE student_number=$1) AS incoming_appointments,
         (SELECT COUNT(*)::int FROM clinic_closure_manual_cases WHERE student_number=$2) AS manual_cases,
         (SELECT COUNT(*)::int FROM appointment_reschedule_events WHERE student_number=$2) AS events,
         (SELECT COUNT(*)::int FROM student_portal_notifications WHERE student_number=$2) AS notifications,
         (SELECT COUNT(*)::int FROM appointments
           WHERE student_number=$2 AND status='PENDING') AS pending_originals`,
      [incomingStudent, displaced.candidate.studentNumber],
    );
    expect(state.rows).toEqual([{
      incoming_appointments: 0,
      manual_cases: 0,
      events: 0,
      notifications: 0,
      pending_originals: 2,
    }]);
  });

  it("plans an April replacement and a same-cycle fallback before applying either", async () => {
    for (const date of ["2028-03-27", "2028-03-28", "2028-03-29", "2028-03-30", "2028-03-31"]) {
      await insertUnifiedDate(date, false);
    }
    const replaceable = await candidateFixture({
      studentNumber: "99-9406-06",
      laboratoryDate: "2028-03-30",
      physicalExamDate: "2028-03-31",
      windowStart: "2028-03-27",
      sourceRowOrder: 3,
      acceptedAt: "2028-03-20T00:00:00.000Z",
    });
    const exhausted = await candidateFixture({
      studentNumber: "99-9407-07",
      laboratoryDate: "2028-03-28",
      physicalExamDate: "2028-03-29",
      windowStart: "2028-07-31",
      sourceRowOrder: 4,
      acceptedAt: "2028-03-21T00:00:00.000Z",
    });

    const replacements = await transaction((client) => publishThroughLiveDisplacementPath({
      candidates: [replaceable.candidate, exhausted.candidate],
      sourceImportGroupId: replaceable.created.importGroupId,
      actorUserId: TEST_REFERENCE_IDS.adminUser,
    }, client));

    expect(replacements).toEqual([
      expect.objectContaining({
        studentNumber: "99-9406-06",
        laboratoryDate: "2028-04-03",
        physicalExamDate: "2028-04-04",
      }),
    ]);
    const replacementRows = await pool.query(
      `SELECT status,appointment_date::text,scheduling_category,
              scheduling_accepted_at,scheduling_source_row_order,
              scheduling_window_start::text,scheduling_window_end::text,
              schedule_pair_id::text,schedule_cycle_start
         FROM appointments
        WHERE student_number='99-9406-06' AND rescheduled_from IS NOT NULL
        ORDER BY schedule_type`,
    );
    expect(replacementRows.rows).toEqual([
      {
        status: "PENDING",
        appointment_date: "2028-04-03",
        scheduling_category: "REGULAR",
        scheduling_accepted_at: new Date("2028-03-20T00:00:00.000Z"),
        scheduling_source_row_order: 3,
        scheduling_window_start: "2028-03-27",
        scheduling_window_end: "2028-03-31",
        schedule_pair_id: replaceable.created.pairId,
        schedule_cycle_start: 2027,
      },
      {
        status: "PENDING",
        appointment_date: "2028-04-04",
        scheduling_category: "REGULAR",
        scheduling_accepted_at: new Date("2028-03-20T00:00:00.000Z"),
        scheduling_source_row_order: 3,
        scheduling_window_start: "2028-03-27",
        scheduling_window_end: "2028-03-31",
        schedule_pair_id: replaceable.created.pairId,
        schedule_cycle_start: 2027,
      },
    ]);
    const replacementEvent = await pool.query(
      `SELECT strategy,outcome,policy_metadata
         FROM appointment_reschedule_events
        WHERE student_number='99-9406-06'`,
    );
    expect(replacementEvent.rows).toEqual([{
      strategy: "MOVE_COMPLETE_PAIR",
      outcome: "REPLACED",
      policy_metadata: expect.objectContaining({
        originAppointmentIds: [
          replaceable.created.laboratory.id,
          replaceable.created.physicalExam.id,
        ],
        schedulePairId: replaceable.created.pairId,
        schedulingAcceptedAt: "2028-03-20T00:00:00.000Z",
        schedulingSourceRowOrder: 3,
      }),
    }]);
    const fallback = await pool.query(
      `SELECT manual_case.case_source,manual_case.closure_group_id,
              manual_case.reason_code,manual_case.policy_metadata,
              event.outcome,event.policy_reason_code,
              event.new_laboratory_appointment_id,event.new_physical_exam_appointment_id
         FROM clinic_closure_manual_cases manual_case
         JOIN appointment_reschedule_events event ON event.manual_case_id=manual_case.id
        WHERE manual_case.student_number='99-9407-07'`,
    );
    expect(fallback.rows).toEqual([expect.objectContaining({
      case_source: "AUTOMATIC_DISPLACEMENT",
      closure_group_id: null,
      reason_code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE",
      policy_metadata: expect.objectContaining({
        schedulingWindowStart: "2028-07-31",
        scheduleCycleClosingDate: "2028-07-31",
        sourceImportGroupId: replaceable.created.importGroupId,
      }),
      outcome: "AWAITING_RESCHEDULE",
      policy_reason_code: "NO_VALID_REPLACEMENT_WITHIN_CYCLE",
      new_laboratory_appointment_id: null,
      new_physical_exam_appointment_id: null,
    })]);
    const fallbackAppointments = await pool.query<{ status: string }>(
      "SELECT status FROM appointments WHERE student_number='99-9407-07' ORDER BY schedule_type",
    );
    expect(fallbackAppointments.rows).toEqual([
      { status: "AWAITING_RESCHEDULE" },
      { status: "AWAITING_RESCHEDULE" },
    ]);
    const fallbackNotification = await pool.query(
      `SELECT notification_type,metadata->>'sourceType' AS source_type,message
         FROM student_portal_notifications WHERE student_number='99-9407-07'`,
    );
    expect(fallbackNotification.rows).toEqual([{
      notification_type: "SCHEDULE_AWAITING_RESOLUTION",
      source_type: "AUTOMATIC_DISPLACEMENT_MANUAL_CASE",
      message: expect.not.stringContaining("2028-08"),
    }]);
  });
});
