// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction } from "@/server/db/pool";
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
import { publishDisplacedRegularReplacements } from "./priority-displacement.service";

const studentPattern = "99-94%";
const importPattern = "TEST-DISPLACE-UNIFIED%";
let capacityFixture: CapacityFixtureLock | null = null;

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
}

async function fixture(studentNumber: string) {
  await insertTestStudent({
    studentNumber,
    firstName: "Priority",
    lastName: "Displacement",
    yearLevel: 4,
  });
  const importGroup = await pool.query<{ id: string }>(
    `INSERT INTO schedule_import_groups (
       import_name,source_filename,total_rows,created_by,student_category,academic_year_start
     ) VALUES ($1,$1,1,$2,'REGULAR',2027) RETURNING id::text`,
    [`${importPattern.replace("%", "")}-${studentNumber}`, TEST_REFERENCE_IDS.adminUser],
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
      `${importPattern.replace("%", "")}-${studentNumber}`,
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

async function eligibleFixture(studentNumber: string) {
  const created = await fixture(studentNumber);
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
         batch_id,clinic_id,student_number,schedule_type,priority_group_id,
         target_date,status,source_row_order,schedule_cycle_start
       )
       SELECT batch_id,clinic_id,student_number,schedule_type,NULL,
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
    const result = await publishDisplacedRegularReplacements({
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
});
afterEach(async () => {
  if (!capacityFixture) return;
  await cleanupAndRestoreCapacitySettings(pool, capacityFixture.originalCapacities, cleanup);
});
afterAll(async () => {
  if (!capacityFixture) return;
  await teardownCapacityFixtureLock(pool, capacityFixture, cleanup);
});

describe("priority displacement with the unified closure calendar", () => {
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
    await transaction((client) => publishDisplacedRegularReplacements({
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

    const replacements = await transaction((client) => publishDisplacedRegularReplacements({
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
      await publishDisplacedRegularReplacements({
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

    const replacements = await transaction((client) => publishDisplacedRegularReplacements({
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
