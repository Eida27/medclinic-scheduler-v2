// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  cancelOvpsaFirstYearBatch,
  createOvpsaFirstYearBatch,
  publishOvpsaFirstYearBatch,
  rescheduleOvpsaFirstYearBatch,
  validateOvpsaFirstYearBatch,
} from "./ovpsa-first-year.service";
import {
  confirmOvpsaClinicClosureBatchRecovery,
  previewOvpsaClinicClosureBatchRecovery,
  saveClinicCalendarChanges,
} from "@/server/services/clinic-calendar.service";
import { markOverdueAppointmentsNoShow } from "@/server/repositories/appointment-no-show.repository";
import type { SessionUser } from "@/types/roles";
import { planOvpsaLowerPriorityDisplacementsForServiceDates } from "./ovpsa-first-year-displacement";
import type { StoredOvpsaBatch } from "./ovpsa-first-year.repository";

const studentPrefix = "OVP-T1-";
const cycleStart = 2096;
const adminActor: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "Test Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
};

async function cleanup() {
  await pool.query(
    `DELETE FROM audit_logs
      WHERE entity_type LIKE 'ovpsa_first_year%'
         OR entity_id IN (SELECT id::text FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)
         OR metadata->>'studentNumber' LIKE $2
         OR metadata->>'batchId' IN (
           SELECT creation_batch_id::text FROM clinic_closure_groups WHERE reason LIKE 'OVP-T1 closure%'
         )`,
    [cycleStart, `${studentPrefix}%`],
  );
  await pool.query(
    "DELETE FROM email_outbox WHERE student_number LIKE $1",
    [`${studentPrefix}%`],
  );
  await pool.query(
    "DELETE FROM student_portal_notifications WHERE student_number LIKE $1",
    [`${studentPrefix}%`],
  );
  await pool.query(
    `DELETE FROM ovpsa_external_laboratory_verifications
      WHERE batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)`,
    [cycleStart],
  );
  await pool.query(
    `DELETE FROM appointment_reschedule_events
      WHERE ovpsa_batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)
         OR student_number LIKE $2`,
    [cycleStart, `${studentPrefix}%`],
  );
  await pool.query(
    "DELETE FROM clinic_closure_manual_cases WHERE student_number LIKE $1",
    [`${studentPrefix}%`],
  );
  await pool.query(
    "DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM appointments WHERE student_number LIKE $1)",
    [`${studentPrefix}%`],
  );
  await pool.query(
    "DELETE FROM appointments WHERE student_number LIKE $1",
    [`${studentPrefix}%`],
  );
  await pool.query(
    "DELETE FROM coordinator_schedule_items WHERE student_number LIKE $1",
    [`${studentPrefix}%`],
  );
  await pool.query(
    `DELETE FROM schedule_batches
      WHERE batch_name LIKE 'OVP-T1-%'
         OR import_group_id IN (
           SELECT id FROM schedule_import_groups WHERE import_name LIKE 'OVP-T1-%'
         )`,
  );
  await pool.query(
    "DELETE FROM schedule_import_groups WHERE import_name LIKE 'OVP-T1-%'",
  );
  await pool.query(
    "DELETE FROM ovpsa_first_year_active_memberships WHERE batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)",
    [cycleStart],
  );
  await pool.query(
    "DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)",
    [cycleStart],
  );
  await pool.query("ALTER TABLE ovpsa_first_year_membership_snapshots DISABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
  await pool.query(
    "DELETE FROM ovpsa_first_year_membership_snapshots WHERE batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)",
    [cycleStart],
  );
  await pool.query("ALTER TABLE ovpsa_first_year_membership_snapshots ENABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
  await pool.query(
    "UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE schedule_cycle_start=$1",
    [cycleStart],
  );
  await pool.query(
    "DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)",
    [cycleStart],
  );
  await pool.query("DELETE FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1", [cycleStart]);
  await pool.query(
    `DELETE FROM clinic_calendar_requests
      WHERE batch_id IN (
        SELECT creation_batch_id FROM clinic_closure_groups WHERE reason LIKE 'OVP-T1 closure%'
      )`,
  );
  await pool.query(
    `DELETE FROM clinic_unavailable_dates
      WHERE closure_group_id IN (
        SELECT id FROM clinic_closure_groups WHERE reason LIKE 'OVP-T1 closure%'
      )`,
  );
  await pool.query("DELETE FROM clinic_closure_groups WHERE reason LIKE 'OVP-T1 closure%'");
  await pool.query("ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable");
  await pool.query(
    "DELETE FROM student_academic_snapshots WHERE student_number LIKE $1 AND academic_year_start=$2",
    [`${studentPrefix}%`, cycleStart],
  );
  await pool.query("ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable");
  await pool.query("DELETE FROM students WHERE student_number LIKE $1", [`${studentPrefix}%`]);
  await pool.query("DELETE FROM academic_years WHERE start_year=$1", [cycleStart]);
}

async function insertStudent(studentNumber: string, yearLevel: number) {
  await pool.query(
    `INSERT INTO students (
       student_number,first_name,middle_name,last_name,college_id,program_id,year_level
     ) VALUES ($1,'First','Maria','Year',$2,$3,$4)`,
    [studentNumber, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program, yearLevel],
  );
}

async function insertLowerPriorityConflict(
  studentNumber: string,
  category: "REGULAR" | "OJT" | "TOUR",
  sourceRowOrder: number,
  options: {
    manuallyLocked?: boolean;
    withLineage?: boolean;
    scheduleCycleStart?: number;
    laboratoryDate?: string;
    physicalExamDate?: string;
  } = {},
) {
  await insertStudent(studentNumber, 4);
  const pairId = randomUUID();
  const appointmentCycleStart = options.scheduleCycleStart ?? cycleStart;
  const laboratoryDate = options.laboratoryDate ?? "2096-09-10";
  const physicalExamDate = options.physicalExamDate ?? "2096-09-11";
  if (options.withLineage === false) {
    const appointments = await pool.query<{ id: string; schedule_type: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,
         is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES
         ($1,$3,'LABORATORY',$8,'PENDING',TRUE,$4,$5,$6,$6,
          $7,CASE WHEN $7 THEN $6::uuid END,CASE WHEN $7 THEN clock_timestamp() END,
          CASE WHEN $7 THEN 'Protected OVPSA fixture' END),
         ($2,$3,'PHYSICAL_EXAM',$9,'PENDING',TRUE,$4,$5,$6,$6,
          FALSE,NULL,NULL,NULL)
       RETURNING id::text,schedule_type`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        studentNumber,
        pairId,
        appointmentCycleStart,
        TEST_REFERENCE_IDS.adminUser,
        options.manuallyLocked ?? false,
        laboratoryDate,
        physicalExamDate,
      ],
    );
    return { pairId, appointments: appointments.rows };
  }
  const importGroup = await pool.query<{ id: string }>(
    `INSERT INTO schedule_import_groups (
       import_name,source_filename,total_rows,created_by,student_category,
       academic_year_start,preferred_month,accepted_at
     ) VALUES ($1,$1,1,$2,$3,$4,$5,$6)
     RETURNING id::text`,
    [
      `OVP-T1-${category}-${studentNumber}`,
      TEST_REFERENCE_IDS.adminUser,
      category,
      appointmentCycleStart,
      category === "REGULAR" ? null : 9,
      `2096-08-0${Math.min(sourceRowOrder, 9)}T00:00:00.000Z`,
    ],
  );
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO schedule_batches (
       clinic_id,batch_name,status,created_by,import_group_id,published_by,published_at
     ) VALUES ($1,$2,'PUBLISHED',$3,$4,$3,clock_timestamp())
     RETURNING id::text`,
    [
      TEST_REFERENCE_IDS.laboratoryClinic,
      `OVP-T1-${category}-${studentNumber}`,
      TEST_REFERENCE_IDS.adminUser,
      importGroup.rows[0].id,
    ],
  );
  const items = await pool.query<{ id: string; schedule_type: string }>(
    `INSERT INTO coordinator_schedule_items (
       batch_id,clinic_id,student_number,schedule_type,target_date,status,
       source_row_order,schedule_cycle_start
     ) VALUES
       ($1,$2,$4,'LABORATORY',$7,'SCHEDULED',$5,$6),
       ($1,$3,$4,'PHYSICAL_EXAM',$8,'SCHEDULED',$5,$6)
     RETURNING id::text,schedule_type`,
    [
      batch.rows[0].id,
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      sourceRowOrder,
      appointmentCycleStart,
      laboratoryDate,
      physicalExamDate,
    ],
  );
  const itemByService = new Map(items.rows.map((item) => [item.schedule_type, item.id]));
  const appointments = await pool.query<{ id: string; schedule_type: string }>(
    `INSERT INTO appointments (
       batch_id,schedule_item_id,clinic_id,student_number,schedule_type,
       appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,
       created_by,updated_by,is_manually_locked,locked_by,locked_at,lock_reason
     ) VALUES
       ($1,$2,$4,$6,'LABORATORY',$11,'PENDING',TRUE,$7,$8,$9,$9,
        $10,CASE WHEN $10 THEN $9::uuid END,CASE WHEN $10 THEN clock_timestamp() END,
        CASE WHEN $10 THEN 'Protected OVPSA fixture' END),
       ($1,$3,$5,$6,'PHYSICAL_EXAM',$12,'PENDING',TRUE,$7,$8,$9,$9,
        FALSE,NULL,NULL,NULL)
     RETURNING id::text,schedule_type`,
    [
      batch.rows[0].id,
      itemByService.get("LABORATORY"),
      itemByService.get("PHYSICAL_EXAM"),
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      pairId,
      appointmentCycleStart,
      TEST_REFERENCE_IDS.adminUser,
      options.manuallyLocked ?? false,
      laboratoryDate,
      physicalExamDate,
    ],
  );
  return { pairId, appointments: appointments.rows };
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,'2097-07-31',$2,$2)`,
    [cycleStart, TEST_REFERENCE_IDS.adminUser],
  );
});
afterEach(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,'2097-07-31',$2,$2)
     ON CONFLICT (start_year) DO NOTHING`,
    [cycleStart, TEST_REFERENCE_IDS.adminUser],
  );
});
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("First Year OVPSA publication", () => {
  it("publishes the complete current Year 1 college membership atomically", async () => {
    const memberOne = `${studentPrefix}0001`;
    const memberTwo = `${studentPrefix}0002`;
    await insertStudent(memberOne, 1);
    await insertStudent(memberTwo, 1);
    await insertStudent(`${studentPrefix}0003`, 2);

    const oldPairId = randomUUID();
    await pool.query(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by
       ) VALUES
         ($1,$3,'LABORATORY','2096-08-20','PENDING',TRUE,$4,$5,$6,$6),
         ($2,$3,'PHYSICAL_EXAM','2096-08-21','PENDING',TRUE,$4,$5,$6,$6)`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        memberOne,
        oldPairId,
        cycleStart,
        TEST_REFERENCE_IDS.adminUser,
      ],
    );

    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-09-10",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );

    expect(validated.members.map((member) => member.studentNumber)).toEqual([
      memberOne,
      memberTwo,
    ]);
    expect(validated.laboratory.locationName).toBe("Iloilo Mission Hospital");
    expect(validated.physicalExam.date).toBe("2096-09-17");
    expect(validated.canPublish).toBe(true);

    await expect(publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    )).resolves.toMatchObject({ status: "PUBLISHED", memberCount: 2 });

    const state = await pool.query<{
      status: string;
      active_memberships: number;
      active_reservations: number;
      membership_snapshots: number;
      academic_snapshots: number;
      linked_appointments: number;
      old_rescheduled: number;
    }>(
      `SELECT batch.status,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_active_memberships active
                WHERE active.batch_id=batch.id AND active.released_at IS NULL) AS active_memberships,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations reservation
                WHERE reservation.batch_id=batch.id AND reservation.status='ACTIVE') AS active_reservations,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_membership_snapshots snapshot
                WHERE snapshot.batch_id=batch.id) AS membership_snapshots,
              (SELECT COUNT(*)::int FROM student_academic_snapshots snapshot
                WHERE snapshot.student_number IN ($2,$3)
                  AND snapshot.academic_year_start=$4
                  AND snapshot.source_type='OVPSA_PUBLICATION') AS academic_snapshots,
              (SELECT COUNT(*)::int FROM appointments appointment
                WHERE appointment.ovpsa_batch_id=batch.id
                  AND appointment.status='PENDING'
                  AND appointment.is_published=TRUE) AS linked_appointments,
              (SELECT COUNT(*)::int FROM appointments appointment
                WHERE appointment.student_number=$2
                  AND appointment.schedule_pair_id=$5
                  AND appointment.status='RESCHEDULED'
                  AND appointment.is_published=FALSE) AS old_rescheduled
         FROM ovpsa_first_year_batches batch WHERE batch.id=$1`,
      [created.batchId, memberOne, memberTwo, cycleStart, oldPairId],
    );
    expect(state.rows).toEqual([{
      status: "PUBLISHED",
      active_memberships: 2,
      active_reservations: 2,
      membership_snapshots: 2,
      academic_snapshots: 2,
      linked_appointments: 4,
      old_rescheduled: 2,
    }]);
    const initial = await pool.query(
      `SELECT notification_type,event_key,metadata->>'sourceType' AS source_type,
              metadata->>'sourceId' AS source_id,message
         FROM student_portal_notifications
        WHERE student_number=$1 AND notification_type='SCHEDULE_INITIAL_PUBLICATION'`,
      [memberTwo],
    );
    expect(initial.rows).toEqual([{
      notification_type: "SCHEDULE_INITIAL_PUBLICATION",
      event_key: `schedule:initial:OVPSA_FIRST_YEAR_REVISION:${created.revisionId}:${memberTwo}`,
      source_type: "OVPSA_FIRST_YEAR_REVISION",
      source_id: created.revisionId,
      message: expect.stringContaining("Iloilo Mission Hospital"),
    }]);
  });

  it("publishes a typed event for the direct OVPSA replacement revision", async () => {
    const member = `${studentPrefix}0004`;
    await insertStudent(member, 1);
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-12-03",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    await saveClinicCalendarChanges({
      requestId: randomUUID(),
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{
        action: "BLOCK",
        date: "2096-12-03",
        category: "CLOSURE",
        reason: "OVP-T1 closure direct reschedule",
      }],
    }, adminActor);
    const invalidated = await pool.query<{ optimistic_token: string }>(
      "SELECT optimistic_token::text FROM ovpsa_first_year_batches WHERE id=$1",
      [created.batchId],
    );
    const replacement = await rescheduleOvpsaFirstYearBatch(created.batchId, {
      optimisticToken: invalidated.rows[0].optimistic_token,
      laboratoryDate: "2096-12-10",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
      reason: "Official closure replacement",
    }, TEST_REFERENCE_IDS.adminUser);
    const event = await pool.query(
      `SELECT notification.notification_type,notification.metadata->>'sourceType' AS source_type,
              notification.metadata->>'sourceId' AS source_id,notification.message
         FROM student_portal_notifications notification
        WHERE notification.student_number=$1
          AND notification.notification_type='SCHEDULE_ADMINISTRATOR_RESCHEDULED'`,
      [member],
    );
    expect(event.rows).toEqual([{
      notification_type: "SCHEDULE_ADMINISTRATOR_RESCHEDULED",
      source_type: "APPOINTMENT_RESCHEDULE_EVENT",
      source_id: expect.any(String),
      message: expect.stringContaining("2096-12-10 at Iloilo Mission Hospital"),
    }]);
    expect(replacement).toMatchObject({ status: "PUBLISHED", revisionNumber: 2 });
  });

  it("rejects a stale optimistic token without publishing anything", async () => {
    await insertStudent(`${studentPrefix}0010`, 1);
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-10-01",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);

    await expect(publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: randomUUID() },
      TEST_REFERENCE_IDS.adminUser,
    )).rejects.toMatchObject({ code: "OVPSA_BATCH_STALE" });
    const state = await pool.query(
      "SELECT status FROM ovpsa_first_year_batches WHERE id=$1",
      [created.batchId],
    );
    expect(state.rows).toEqual([{ status: "DRAFT" }]);
  });

  it("serializes concurrent publications and rolls the losing batch back completely", async () => {
    await insertStudent(`${studentPrefix}0015`, 1);
    const inputs = await Promise.all([1, 2].map(async () => {
      const created = await createOvpsaFirstYearBatch({
        scheduleCycleStart: cycleStart,
        collegeId: TEST_REFERENCE_IDS.college,
        laboratoryDate: "2096-10-12",
        physicalExamDateOverride: null,
        physicalExamExceptionReason: null,
      }, TEST_REFERENCE_IDS.adminUser);
      const validated = await validateOvpsaFirstYearBatch(
        created.batchId,
        { optimisticToken: created.optimisticToken },
        TEST_REFERENCE_IDS.adminUser,
      );
      return { batchId: created.batchId, optimisticToken: validated.optimisticToken };
    }));

    const results = await Promise.allSettled(inputs.map((input) => publishOvpsaFirstYearBatch(
      input.batchId,
      { optimisticToken: input.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    )));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: expect.stringMatching(/^OVPSA_/) },
    });
    const state = await pool.query<{
      published_batches: number;
      active_reservations: number;
      active_memberships: number;
      linked_appointments: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status='PUBLISHED')::int AS published_batches,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations reservation
           WHERE reservation.batch_id=ANY($1::uuid[]) AND reservation.status='ACTIVE') AS active_reservations,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_active_memberships membership
           WHERE membership.batch_id=ANY($1::uuid[]) AND membership.released_at IS NULL) AS active_memberships,
         (SELECT COUNT(*)::int FROM appointments appointment
           WHERE appointment.ovpsa_batch_id=ANY($1::uuid[])) AS linked_appointments
       FROM ovpsa_first_year_batches WHERE id=ANY($1::uuid[])`,
      [inputs.map((input) => input.batchId)],
    );
    expect(state.rows).toEqual([{
      published_batches: 1,
      active_reservations: 2,
      active_memberships: 1,
      linked_appointments: 2,
    }]);
  });

  it("excludes Mission Hospital Laboratory appointments from automatic no-show processing", async () => {
    const member = `${studentPrefix}0018`;
    await insertStudent(member, 1);
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-10-12",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );

    await markOverdueAppointmentsNoShow(new Date("2096-10-20T16:00:00.000Z"), "Asia/Manila");
    const states = await pool.query<{ schedule_type: string; status: string }>(
      `SELECT schedule_type,status FROM appointments
        WHERE ovpsa_batch_id=$1 AND student_number=$2 ORDER BY schedule_type`,
      [created.batchId, member],
    );
    expect(states.rows).toEqual([
      { schedule_type: "LABORATORY", status: "PENDING" },
      { schedule_type: "PHYSICAL_EXAM", status: "NO_SHOW" },
    ]);
  });

  it("replaces conflicts from all active categories with original scheduling lineage", async () => {
    await insertStudent(`${studentPrefix}0100`, 1);
    const categories = ["REGULAR", "OJT", "TOUR"] as const;
    for (const [index, category] of categories.entries()) {
      await insertLowerPriorityConflict(
        `${studentPrefix}01${index + 1}`,
        category,
        index + 1,
      );
    }
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-09-10",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );

    expect(validated.displacements).toHaveLength(3);
    expect(validated.displacements.map((item) => item.category).sort()).toEqual(
      [...categories].sort(),
    );
    expect(validated.proposedReplacements).toHaveLength(3);
    expect(validated.proposedReplacements.map((item) => item.category)).toEqual([
      "OJT",
      "TOUR",
      "REGULAR",
    ]);
    expect(validated.canPublish).toBe(true);
    await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );

    const replacements = await pool.query<{
      category: string;
      count: number;
      lineage_count: number;
    }>(
      `SELECT scheduling_category AS category,COUNT(*)::int AS count,
              COUNT(*) FILTER (
                WHERE scheduling_accepted_at IS NOT NULL
                  AND scheduling_source_row_order IS NOT NULL
                  AND scheduling_window_start IS NOT NULL
                  AND scheduling_window_end IS NOT NULL
              )::int AS lineage_count
         FROM appointments
        WHERE student_number LIKE $1
          AND rescheduled_from IS NOT NULL
          AND status='PENDING'
          AND is_published=TRUE
        GROUP BY scheduling_category
        ORDER BY scheduling_category`,
      [`${studentPrefix}01%`],
    );
    expect(replacements.rows).toEqual([
      { category: "OJT", count: 2, lineage_count: 2 },
      { category: "REGULAR", count: 2, lineage_count: 2 },
      { category: "TOUR", count: 2, lineage_count: 2 },
    ]);
    const displacementNotifications = await pool.query(
      `SELECT COUNT(*)::int AS count FROM student_portal_notifications
        WHERE student_number LIKE $1
          AND notification_type='SCHEDULE_PRIORITY_DISPLACEMENT'
          AND metadata->>'sourceType'='APPOINTMENT_RESCHEDULE_EVENT'`,
      [`${studentPrefix}01%`],
    );
    expect(displacementNotifications.rows).toEqual([{ count: 3 }]);
  });

  it("uses the next Manila clinic day when a persisted scheduling window is historical", async () => {
    const displacedStudent = `${studentPrefix}0180`;
    const conflict = await insertLowerPriorityConflict(
      displacedStudent,
      "REGULAR",
      1,
      {
        scheduleCycleStart: 2026,
        laboratoryDate: "2026-09-10",
        physicalExamDate: "2026-09-11",
      },
    );
    await pool.query(
      `UPDATE appointments
          SET scheduling_category='REGULAR',
              scheduling_accepted_at='2026-08-01T00:00:00.000Z',
              scheduling_source_row_order=17,
              scheduling_window_start='2026-08-01',
              scheduling_window_end='2027-03-31'
        WHERE schedule_pair_id=$1`,
      [conflict.pairId],
    );
    const today = await pool.query<{ date: string }>(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date::text AS date",
    );
    const batch: StoredOvpsaBatch = {
      batchId: "00000000-0000-4000-8000-000000000180",
      scheduleCycleStart: 2026,
      closingDate: "2027-07-31",
      collegeId: TEST_REFERENCE_IDS.college,
      collegeName: "College of Computer Studies",
      status: "DRAFT",
      optimisticToken: "00000000-0000-4000-8000-000000000181",
      revisionId: "00000000-0000-4000-8000-000000000182",
      revisionNumber: 1,
      revisionStatus: "VALIDATED",
      laboratoryDate: "2026-09-10",
      physicalExamDate: "2026-09-17",
      physicalExamExceptionReason: null,
    };
    const client = await pool.connect();
    try {
      const planned = await planOvpsaLowerPriorityDisplacementsForServiceDates(client, {
        batch,
        memberStudentNumbers: [],
        forUpdate: false,
        serviceDates: {
          laboratoryDates: [batch.laboratoryDate],
          physicalExamDates: [batch.physicalExamDate],
        },
      });
      expect(planned.proposedReplacements).toHaveLength(1);
      expect(planned.proposedReplacements[0].laboratoryDate! > today.rows[0].date).toBe(true);
      expect(
        planned.proposedReplacements[0].physicalExamDate
          > planned.proposedReplacements[0].laboratoryDate!,
      ).toBe(true);
    } finally {
      client.release();
    }
  });

  it("continues pair recovery after March and preserves persisted lineage over import fallback", async () => {
    await insertStudent(`${studentPrefix}0181`, 1);
    const displacedStudent = `${studentPrefix}0182`;
    const conflict = await insertLowerPriorityConflict(
      displacedStudent,
      "REGULAR",
      1,
      { laboratoryDate: "2097-03-29", physicalExamDate: "2097-04-01" },
    );
    await pool.query(
      `UPDATE appointments
          SET scheduling_category='OJT',
              scheduling_accepted_at='2097-02-01T01:02:03.000Z',
              scheduling_source_row_order=42,
              scheduling_window_start='2097-03-29',
              scheduling_window_end='2097-03-31'
        WHERE schedule_pair_id=$1`,
      [conflict.pairId],
    );
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2097-03-29",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    expect(validated).toMatchObject({
      canPublish: true,
      proposedReplacements: [{
        studentNumber: displacedStudent,
        category: "OJT",
        laboratoryDate: "2097-04-01",
        physicalExamDate: "2097-04-02",
      }],
    });
    await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    const replacement = await pool.query<{
      schedule_type: string;
      appointment_date: string;
      schedule_pair_id: string;
      scheduling_category: string;
      scheduling_accepted_at: Date;
      scheduling_source_row_order: number;
      scheduling_window_start: string;
      scheduling_window_end: string;
    }>(
      `SELECT schedule_type,appointment_date::text,schedule_pair_id::text,
              scheduling_category,scheduling_accepted_at,
              scheduling_source_row_order,scheduling_window_start::text,
              scheduling_window_end::text
         FROM appointments
        WHERE student_number=$1 AND rescheduled_from IS NOT NULL
        ORDER BY schedule_type`,
      [displacedStudent],
    );
    expect(replacement.rows).toEqual([
      expect.objectContaining({
        schedule_type: "LABORATORY",
        appointment_date: "2097-04-01",
        schedule_pair_id: conflict.pairId,
        scheduling_category: "OJT",
        scheduling_source_row_order: 42,
        scheduling_window_start: "2097-03-29",
        scheduling_window_end: "2097-03-31",
      }),
      expect.objectContaining({
        schedule_type: "PHYSICAL_EXAM",
        appointment_date: "2097-04-02",
        schedule_pair_id: conflict.pairId,
        scheduling_category: "OJT",
        scheduling_source_row_order: 42,
        scheduling_window_start: "2097-03-29",
        scheduling_window_end: "2097-03-31",
      }),
    ]);
    expect(replacement.rows.every(
      (row) => row.scheduling_accepted_at.toISOString() === "2097-02-01T01:02:03.000Z",
    )).toBe(true);
  });

  it("publishes First Year ownership atomically with a pair Manual Resolution fallback at cycle close", async () => {
    const member = `${studentPrefix}0183`;
    const displacedStudent = `${studentPrefix}0184`;
    await insertStudent(member, 1);
    const conflict = await insertLowerPriorityConflict(
      displacedStudent,
      "REGULAR",
      3,
      { laboratoryDate: "2097-03-13", physicalExamDate: "2097-03-14" },
    );
    await pool.query(
      "UPDATE students SET email='ovpsa.fallback@example.test',email_verified_at=NOW() WHERE student_number=$1",
      [displacedStudent],
    );
    await pool.query(
      `UPDATE appointments
          SET scheduling_category='REGULAR',
              scheduling_accepted_at='2097-03-01T00:00:00.000Z',
              scheduling_source_row_order=3,
              scheduling_window_start='2097-03-20',
              scheduling_window_end='2097-03-20'
        WHERE schedule_pair_id=$1`,
      [conflict.pairId],
    );
    await pool.query(
      "UPDATE academic_years SET closing_date='2097-03-20' WHERE start_year=$1",
      [cycleStart],
    );
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2097-03-13",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    expect(validated).toMatchObject({
      canPublish: true,
      displacements: [{ studentNumber: displacedStudent, displacementType: "PAIR" }],
      proposedReplacements: [],
    });
    await expect(publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    )).resolves.toMatchObject({ status: "PUBLISHED" });

    const state = await pool.query<{
      incoming_appointments: number;
      awaiting_appointments: number;
      replacement_appointments: number;
      manual_cases: number;
      manual_events: number;
      audits: number;
      notifications: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM appointments
           WHERE ovpsa_batch_id=$1 AND status='PENDING' AND is_published=TRUE) AS incoming_appointments,
         (SELECT COUNT(*)::int FROM appointments
           WHERE student_number=$2 AND status='AWAITING_RESCHEDULE' AND is_published=TRUE) AS awaiting_appointments,
         (SELECT COUNT(*)::int FROM appointments
           WHERE student_number=$2 AND rescheduled_from IS NOT NULL) AS replacement_appointments,
         (SELECT COUNT(*)::int FROM clinic_closure_manual_cases
           WHERE student_number=$2 AND case_source='AUTOMATIC_DISPLACEMENT'
             AND status='OPEN' AND reason_code='NO_VALID_REPLACEMENT_WITHIN_CYCLE') AS manual_cases,
         (SELECT COUNT(*)::int FROM appointment_reschedule_events event
           JOIN clinic_closure_manual_cases manual_case ON manual_case.id=event.manual_case_id
          WHERE event.student_number=$2 AND event.cause='OVPSA_PUBLICATION'
            AND event.strategy='MANUAL_RESOLUTION_REQUIRED'
            AND event.outcome='AWAITING_RESCHEDULE'
            AND event.policy_reason_code='NO_VALID_REPLACEMENT_WITHIN_CYCLE'
            AND event.new_laboratory_appointment_id IS NULL
            AND event.new_physical_exam_appointment_id IS NULL) AS manual_events,
         (SELECT COUNT(*)::int FROM audit_logs
           WHERE action='OVPSA_DISPLACEMENT_MANUAL_RESOLUTION_REQUIRED'
             AND metadata->>'studentNumber'=$2) AS audits,
         (SELECT COUNT(*)::int FROM student_portal_notifications
           WHERE student_number=$2
             AND metadata->>'sourceType'='AUTOMATIC_DISPLACEMENT_MANUAL_CASE'
             AND message NOT LIKE '%2097-03-2%') AS notifications`,
      [created.batchId, displacedStudent],
    );
    expect(state.rows).toEqual([{
      incoming_appointments: 2,
      awaiting_appointments: 2,
      replacement_appointments: 0,
      manual_cases: 1,
      manual_events: 1,
      audits: 1,
      notifications: 1,
    }]);
  });

  it("keeps a completed Laboratory and replaces only Physical Examination after Lab plus one", async () => {
    await insertStudent(`${studentPrefix}0185`, 1);
    const displacedStudent = `${studentPrefix}0186`;
    const conflict = await insertLowerPriorityConflict(
      displacedStudent,
      "REGULAR",
      5,
      { laboratoryDate: "2097-03-19", physicalExamDate: "2097-03-20" },
    );
    await pool.query(
      `UPDATE appointments
          SET status=CASE WHEN schedule_type='LABORATORY' THEN 'COMPLETED' ELSE status END,
              scheduling_category='REGULAR',
              scheduling_accepted_at='2097-03-01T00:00:00.000Z',
              scheduling_source_row_order=5,
              scheduling_window_start='2097-03-17',
              scheduling_window_end='2097-03-22'
        WHERE schedule_pair_id=$1`,
      [conflict.pairId],
    );
    await pool.query(
      "UPDATE academic_years SET closing_date='2097-03-22' WHERE start_year=$1",
      [cycleStart],
    );
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2097-03-13",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    expect(validated).toMatchObject({
      canPublish: true,
      proposedReplacements: [{
        studentNumber: displacedStudent,
        laboratoryDate: null,
        physicalExamDate: "2097-03-21",
      }],
    });
    await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    const appointments = await pool.query<{
      schedule_type: string;
      appointment_date: string;
      status: string;
      is_published: boolean;
    }>(
      `SELECT schedule_type,appointment_date::text,status,is_published
         FROM appointments WHERE student_number=$1 ORDER BY created_at,id`,
      [displacedStudent],
    );
    expect(appointments.rows).toEqual(expect.arrayContaining([
      { schedule_type: "LABORATORY", appointment_date: "2097-03-19", status: "COMPLETED", is_published: true },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2097-03-20", status: "RESCHEDULED", is_published: false },
      { schedule_type: "PHYSICAL_EXAM", appointment_date: "2097-03-21", status: "PENDING", is_published: true },
    ]));
  });

  it("uses deterministic legacy import lineage but still blocks protected conflicts", async () => {
    await insertStudent(`${studentPrefix}0200`, 1);
    await insertLowerPriorityConflict(
      `${studentPrefix}0201`,
      "REGULAR",
      1,
      { manuallyLocked: true },
    );
    const legacyStudent = `${studentPrefix}0202`;
    const legacy = await insertLowerPriorityConflict(legacyStudent, "REGULAR", 2);
    await pool.query(
      `UPDATE appointments
          SET scheduling_category=NULL,scheduling_accepted_at=NULL,
              scheduling_source_row_order=NULL,scheduling_window_start=NULL,
              scheduling_window_end=NULL
        WHERE schedule_pair_id=$1`,
      [legacy.pairId],
    );
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-09-10",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );

    expect(validated.canPublish).toBe(false);
    expect(validated.protectedConflicts.map((conflict) => conflict.reasonCode)).toEqual([
      "APPOINTMENT_MANUALLY_LOCKED",
    ]);
    expect(validated.displacements).toEqual([
      expect.objectContaining({ studentNumber: legacyStudent, category: "REGULAR", sourceRowOrder: 2 }),
    ]);
    const reservations = await pool.query(
      "SELECT 1 FROM ovpsa_first_year_service_reservations WHERE batch_id=$1",
      [created.batchId],
    );
    expect(reservations.rowCount).toBe(0);
  });

  it("fails with a stable cycle configuration error when no academic year is configured", async () => {
    await expect(createOvpsaFirstYearBatch({
      scheduleCycleStart: 2088,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2088-09-10",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser)).rejects.toMatchObject({
      code: "OVPSA_ACADEMIC_YEAR_OR_COLLEGE_UNAVAILABLE",
      status: 409,
    });
  });

  it("restores appointments displaced by a released reservation and audits the decision", async () => {
    await insertStudent(`${studentPrefix}0250`, 1);
    const displacedStudent = `${studentPrefix}0251`;
    const original = await insertLowerPriorityConflict(displacedStudent, "REGULAR", 1);
    const originalIds = original.appointments.map((appointment) => appointment.id);
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-09-10",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    const published = await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );

    await cancelOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: published.optimisticToken, reason: "Restore the displaced schedule fixture." },
      TEST_REFERENCE_IDS.adminUser,
    );

    const appointments = await pool.query<{
      id: string;
      status: string;
      is_published: boolean;
      rescheduled_from: string | null;
    }>(
      `SELECT id::text,status,is_published,rescheduled_from::text
         FROM appointments WHERE student_number=$1 ORDER BY created_at,id`,
      [displacedStudent],
    );
    expect(appointments.rows.filter((appointment) => originalIds.includes(appointment.id))).toEqual(
      expect.arrayContaining(originalIds.map((id) => expect.objectContaining({
        id,
        status: "PENDING",
        is_published: true,
      }))),
    );
    expect(appointments.rows.filter((appointment) => appointment.rescheduled_from)).toEqual(
      expect.arrayContaining(originalIds.map((id) => expect.objectContaining({
        rescheduled_from: id,
        status: "RESCHEDULED",
        is_published: false,
      }))),
    );
    const restoration = await pool.query<{ decision: string; audits: number }>(
      `SELECT event.restoration_decision AS decision,
              (SELECT COUNT(*)::int FROM audit_logs audit
                WHERE audit.action='OVPSA_DISPLACEMENT_RESTORATION_DECIDED'
                  AND audit.metadata->>'rescheduleEventId'=event.id::text) AS audits
         FROM appointment_reschedule_events event
        WHERE event.student_number=$1 AND event.ovpsa_batch_id=$2`,
      [displacedStudent, created.batchId],
    );
    expect(restoration.rows).toEqual([{ decision: "RESTORED", audits: 1 }]);
    const restoredNotification = await pool.query(
      `SELECT notification_type,metadata->>'sourceId' AS source_id,message
         FROM student_portal_notifications
        WHERE student_number=$1 AND notification_type='SCHEDULE_RESTORED'`,
      [displacedStudent],
    );
    expect(restoredNotification.rows).toEqual([{
      notification_type: "SCHEDULE_RESTORED",
      source_id: expect.any(String),
      message: expect.stringContaining("2096-09-10 at KABALAKA Clinic"),
    }]);
  });

  it("automatically recovers an OVPSA PE-only closure without claiming an exclusive date", async () => {
    const member = `${studentPrefix}0299`;
    await insertStudent(member, 1);
    await pool.query(
      "UPDATE students SET email='ovpsa.pe.recovery@example.test',email_verified_at=NOW() WHERE student_number=$1",
      [member],
    );
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-11-05",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );

    const result = await saveClinicCalendarChanges({
      requestId: randomUUID(),
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{
        action: "BLOCK",
        date: "2096-11-12",
        category: "CLOSURE",
        reason: "OVP-T1 closure PE only",
      }],
    }, adminActor);
    expect(result).toMatchObject({
      autoRecoveredStudentCount: 1,
      movedAppointmentCount: 1,
      manualCaseCount: 0,
    });
    const state = await pool.query<{
      batch_status: string;
      current_revision_id: string;
      original_revision_id: string;
      pending_laboratory: number;
      pending_physical: number;
      recovery_reservations: number;
      exclusive_physical_active: number;
    }>(
      `SELECT batch.status AS batch_status,batch.current_revision_id::text,
              $2::text AS original_revision_id,
              (SELECT COUNT(*)::int FROM appointments
                WHERE ovpsa_batch_id=batch.id AND schedule_type='LABORATORY'
                  AND status='PENDING' AND is_published=TRUE) AS pending_laboratory,
              (SELECT COUNT(*)::int FROM appointments
                WHERE ovpsa_batch_id=batch.id AND schedule_type='PHYSICAL_EXAM'
                  AND status='PENDING' AND is_published=TRUE) AS pending_physical,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
                WHERE batch_id=batch.id AND reservation_kind='CLOSURE_RECOVERY'
                  AND status='ACTIVE') AS recovery_reservations,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
                WHERE batch_id=batch.id AND schedule_type='PHYSICAL_EXAM'
                  AND reservation_kind='EXCLUSIVE' AND status='ACTIVE') AS exclusive_physical_active
         FROM ovpsa_first_year_batches batch WHERE id=$1`,
      [created.batchId, created.revisionId],
    );
    expect(state.rows).toEqual([{
      batch_status: "PUBLISHED",
      current_revision_id: created.revisionId,
      original_revision_id: created.revisionId,
      pending_laboratory: 1,
      pending_physical: 1,
      recovery_reservations: 1,
      exclusive_physical_active: 0,
    }]);
    const recoveredPhysical = await pool.query<{ appointment_date: string }>(
      `SELECT appointment_date::text FROM appointments
        WHERE student_number=$1 AND ovpsa_batch_id=$2
          AND schedule_type='PHYSICAL_EXAM' AND status='PENDING' AND is_published=TRUE`,
      [member, created.batchId],
    );
    expect(recoveredPhysical.rows).toEqual([{ appointment_date: "2096-11-13" }]);
    const closureNotification = await pool.query(
      `SELECT notification.notification_type,notification.event_key,
              notification.metadata->>'sourceType' AS source_type,
              notification.metadata->>'sourceId' AS source_id,
              notification.metadata->>'scheduleFingerprint' AS fingerprint,
              outbox.text_body
         FROM student_portal_notifications notification
         JOIN email_outbox outbox ON outbox.portal_notification_id=notification.id
        WHERE notification.student_number=$1
          AND notification.notification_type='SCHEDULE_CLOSURE_RESCHEDULED'`,
      [member],
    );
    expect(closureNotification.rows).toEqual([{
      notification_type: "SCHEDULE_CLOSURE_RESCHEDULED",
      event_key: expect.stringMatching(/^schedule:event:[0-9a-f-]+:OVP-T1-0299$/),
      source_type: "APPOINTMENT_RESCHEDULE_EVENT",
      source_id: expect.any(String),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      text_body: expect.stringMatching(/Previous Physical Examination: 2096-11-12 at CPU Clinic[\s\S]*Physical Examination: 2096-11-13 at CPU Clinic \(Pending\)[\s\S]*Reason: OVP-T1 closure PE only/),
    }]);

    const currentBatch = await pool.query<{ optimistic_token: string }>(
      "SELECT optimistic_token::text FROM ovpsa_first_year_batches WHERE id=$1",
      [created.batchId],
    );
    const cancellationReason = "OVPSA cancelled after automatic PE recovery.";
    await cancelOvpsaFirstYearBatch(created.batchId, {
      optimisticToken: currentBatch.rows[0].optimistic_token,
      reason: cancellationReason,
    }, TEST_REFERENCE_IDS.adminUser);
    const cancellation = await pool.query(
      `SELECT notification.notification_type,notification.event_key,
              notification.message,
              notification.metadata->>'sourceType' AS source_type,
              notification.metadata->>'sourceId' AS source_id,
              notification.metadata->>'scheduleFingerprint' AS fingerprint,
              outbox.source_id AS outbox_source_id,outbox.schedule_fingerprint,
              outbox.text_body
         FROM student_portal_notifications notification
         JOIN email_outbox outbox ON outbox.portal_notification_id=notification.id
        WHERE notification.student_number=$1
          AND notification.notification_type='SCHEDULE_CANCELLED'`,
      [member],
    );
    expect(cancellation.rows).toEqual([{
      notification_type: "SCHEDULE_CANCELLED",
      event_key: `schedule:event:${created.batchId}:${member}`,
      message: expect.stringContaining("No current Laboratory or Physical Examination appointment is assigned."),
      source_type: "OVPSA_FIRST_YEAR_BATCH",
      source_id: created.batchId,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      outbox_source_id: created.batchId,
      schedule_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      text_body: expect.stringMatching(/Previous Laboratory: 2096-11-05 at Iloilo Mission Hospital[\s\S]*Previous Physical Examination: 2096-11-13 at CPU Clinic[\s\S]*Reason: OVPSA cancelled after automatic PE recovery\./),
    }]);
    expect(cancellation.rows[0].text_body).not.toContain(
      "Previous Physical Examination: 2096-11-12 at CPU Clinic",
    );
  });

  it("marks a closed OVPSA date for reschedule, publishes a replacement revision, and cancels safely", async () => {
    const preservedMember = `${studentPrefix}0300`;
    const affectedMember = `${studentPrefix}0301`;
    const safePhysicalMember = `${studentPrefix}0302`;
    await insertStudent(preservedMember, 1);
    await insertStudent(affectedMember, 1);
    await insertStudent(safePhysicalMember, 1);
    const created = await createOvpsaFirstYearBatch({
      scheduleCycleStart: cycleStart,
      collegeId: TEST_REFERENCE_IDS.college,
      laboratoryDate: "2096-11-05",
      physicalExamDateOverride: null,
      physicalExamExceptionReason: null,
    }, TEST_REFERENCE_IDS.adminUser);
    const validated = await validateOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: created.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    await publishOvpsaFirstYearBatch(
      created.batchId,
      { optimisticToken: validated.optimisticToken },
      TEST_REFERENCE_IDS.adminUser,
    );
    await pool.query(
      `UPDATE appointments
          SET status='COMPLETED',updated_by=$2
        WHERE ovpsa_batch_id=$1 AND student_number=$3`,
      [created.batchId, TEST_REFERENCE_IDS.adminUser, preservedMember],
    );
    await pool.query(
      `UPDATE appointments
          SET appointment_date='2096-11-27',updated_by=$2
        WHERE ovpsa_batch_id=$1 AND student_number=$3
          AND schedule_type='PHYSICAL_EXAM'`,
      [created.batchId, TEST_REFERENCE_IDS.adminUser, safePhysicalMember],
    );

    await saveClinicCalendarChanges({
      requestId: randomUUID(),
      emergencyAcknowledged: false,
      recoveryMode: "AUTO_ELIGIBLE",
      changes: [{
        action: "BLOCK",
        date: "2096-11-05",
        category: "CLOSURE",
        reason: "OVP-T1 closure fixture",
      }],
    }, adminActor);
    const invalidated = await pool.query<{
      batch_status: string;
      reservation_status: string;
      awaiting_laboratory: number;
      pending_physical: number;
      completed_preserved: number;
      optimistic_token: string;
    }>(
      `SELECT batch.status AS batch_status,batch.optimistic_token::text,
              reservation.status AS reservation_status,
              (SELECT COUNT(*)::int FROM appointments
                WHERE ovpsa_batch_id=batch.id AND schedule_type='LABORATORY'
                  AND status='AWAITING_RESCHEDULE') AS awaiting_laboratory,
              (SELECT COUNT(*)::int FROM appointments
                WHERE ovpsa_batch_id=batch.id AND schedule_type='PHYSICAL_EXAM'
                  AND status='PENDING') AS pending_physical,
              (SELECT COUNT(*)::int FROM appointments
                WHERE ovpsa_batch_id=batch.id AND student_number=$2
                  AND status='COMPLETED') AS completed_preserved
         FROM ovpsa_first_year_batches batch
         JOIN ovpsa_first_year_service_reservations reservation
           ON reservation.batch_id=batch.id AND reservation.schedule_type='LABORATORY'
        WHERE batch.id=$1`,
      [created.batchId, preservedMember],
    );
    expect(invalidated.rows).toEqual([expect.objectContaining({
      batch_status: "RESCHEDULE_REQUIRED",
      reservation_status: "INVALIDATED",
      awaiting_laboratory: 2,
      pending_physical: 2,
      completed_preserved: 2,
    })]);

    await pool.query(
      "UPDATE students SET email='ovpsa.manual.completion@example.test',email_verified_at=NOW() WHERE student_number=$1",
      [affectedMember],
    );
    const manualCases = await pool.query<{
      id: string;
      optimistic_token: string;
      student_number: string;
    }>(
      `SELECT id::text,optimistic_token::text,student_number FROM clinic_closure_manual_cases
        WHERE policy_metadata->>'ovpsaBatchId'=$1 AND status='OPEN' ORDER BY id`,
      [created.batchId],
    );
    expect(manualCases.rows).toHaveLength(2);
    const preview = await previewOvpsaClinicClosureBatchRecovery(
      created.batchId,
      {
        optimisticToken: invalidated.rows[0].optimistic_token,
        replacementLaboratoryDate: "2096-11-19",
      },
      adminActor,
    );
    expect(preview).toMatchObject({
      linkedCaseCount: 2,
      preservedPhysicalExamCount: 1,
      movedPhysicalExamCount: 1,
    });
    await expect(confirmOvpsaClinicClosureBatchRecovery(
      created.batchId,
      {
        optimisticToken: invalidated.rows[0].optimistic_token,
        replacementLaboratoryDate: "2096-11-19",
        caseTokens: manualCases.rows.map((item, index) => ({
          caseId: item.id,
          expectedOptimisticToken: index === 0 ? randomUUID() : item.optimistic_token,
        })),
        reason: "This stale confirmation must remain atomic.",
      },
      adminActor,
    )).rejects.toMatchObject({ code: "OVPSA_BATCH_RECOVERY_CASES_STALE", status: 409 });
    await expect(pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ovpsa_first_year_batch_revisions WHERE batch_id=$1) AS revisions,
         (SELECT COUNT(*)::int FROM clinic_closure_manual_cases
           WHERE policy_metadata->>'ovpsaBatchId'=$1::text AND status='OPEN') AS open_cases`,
      [created.batchId],
    )).resolves.toMatchObject({ rows: [{ revisions: 1, open_cases: 2 }] });
    const rescheduled = await confirmOvpsaClinicClosureBatchRecovery(
      created.batchId,
      {
        optimisticToken: invalidated.rows[0].optimistic_token,
        replacementLaboratoryDate: "2096-11-19",
        caseTokens: manualCases.rows.map((item) => ({
          caseId: item.id,
          expectedOptimisticToken: item.optimistic_token,
        })),
        reason: "OVPSA approved replacement after closure.",
      },
      adminActor,
    );
    expect(rescheduled).toMatchObject({ revisionNumber: 2 });
    const affectedCase = manualCases.rows.find((item) => item.student_number === affectedMember)!;
    const completion = await pool.query(
      `SELECT notification.notification_type,notification.event_key,
              notification.metadata->>'sourceType' AS source_type,
              notification.metadata->>'sourceId' AS source_id,
              notification.metadata->>'scheduleFingerprint' AS fingerprint,
              outbox.text_body
         FROM student_portal_notifications notification
         JOIN email_outbox outbox ON outbox.portal_notification_id=notification.id
        WHERE notification.student_number=$1
          AND notification.notification_type='SCHEDULE_MANUAL_RESOLUTION_COMPLETED'`,
      [affectedMember],
    );
    expect(completion.rows).toEqual([{
      notification_type: "SCHEDULE_MANUAL_RESOLUTION_COMPLETED",
      event_key: `schedule:event:${affectedCase.id}-resolved:${affectedMember}`,
      source_type: "CLINIC_CLOSURE_MANUAL_CASE",
      source_id: affectedCase.id,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      text_body: expect.stringMatching(/Previous Laboratory: 2096-11-05 at Iloilo Mission Hospital[\s\S]*Laboratory: 2096-11-19 at Iloilo Mission Hospital \(Pending\)[\s\S]*Reason: OVPSA approved replacement after closure\./),
    }]);
    const replacement = await pool.query<{
      revision_count: number;
      active_reservations: number;
      old_released: number;
      new_pending: number;
      completed_preserved: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM ovpsa_first_year_batch_revisions WHERE batch_id=$1) AS revision_count,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
           WHERE batch_id=$1 AND status='ACTIVE') AS active_reservations,
         (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
           WHERE batch_id=$1 AND status='RELEASED') AS old_released,
         (SELECT COUNT(*)::int FROM appointments
           WHERE ovpsa_batch_id=$1 AND ovpsa_revision_id=$2
             AND status='PENDING' AND is_published=TRUE) AS new_pending,
         (SELECT COUNT(*)::int FROM appointments
           WHERE ovpsa_batch_id=$1 AND student_number=$3
             AND status='COMPLETED' AND is_published=TRUE) AS completed_preserved`,
      [created.batchId, rescheduled.revisionId, preservedMember],
    );
    expect(replacement.rows).toEqual([{
      revision_count: 2,
      active_reservations: 3,
      old_released: 2,
      new_pending: 4,
      completed_preserved: 2,
    }]);

    await cancelOvpsaFirstYearBatch(
      created.batchId,
      {
        optimisticToken: rescheduled.optimisticToken,
        reason: "OVPSA cancelled the remaining First Year schedule.",
      },
      TEST_REFERENCE_IDS.adminUser,
    );
    const cancelled = await pool.query<{
      status: string;
      unfinished: number;
      active_memberships: number;
      active_reservations: number;
    }>(
      `SELECT batch.status,
              (SELECT COUNT(*)::int FROM appointments
                WHERE ovpsa_batch_id=batch.id AND status='CANCELLED') AS unfinished,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_active_memberships
                WHERE batch_id=batch.id AND released_at IS NULL) AS active_memberships,
              (SELECT COUNT(*)::int FROM ovpsa_first_year_service_reservations
                WHERE batch_id=batch.id AND status IN ('ACTIVE','INVALIDATED')) AS active_reservations
         FROM ovpsa_first_year_batches batch WHERE id=$1`,
      [created.batchId],
    );
    expect(cancelled.rows).toEqual([{
      status: "CANCELLED",
      unfinished: 4,
      active_memberships: 0,
      active_reservations: 0,
    }]);
    const cancellationNotifications = await pool.query(
      `SELECT COUNT(*)::int AS count FROM student_portal_notifications
        WHERE student_number=ANY($1::text[])
          AND notification_type='SCHEDULE_CANCELLED'
          AND metadata->>'sourceType'='OVPSA_FIRST_YEAR_BATCH'
          AND metadata->>'sourceId'=$2`,
      [[preservedMember, affectedMember, safePhysicalMember], created.batchId],
    );
    expect(cancellationNotifications.rows).toEqual([{ count: 3 }]);
  });
});
