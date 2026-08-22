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
  options: { manuallyLocked?: boolean; withLineage?: boolean } = {},
) {
  await insertStudent(studentNumber, 4);
  const pairId = randomUUID();
  if (options.withLineage === false) {
    const appointments = await pool.query<{ id: string; schedule_type: string }>(
      `INSERT INTO appointments (
         clinic_id,student_number,schedule_type,appointment_date,status,is_published,
         schedule_pair_id,schedule_cycle_start,created_by,updated_by,
         is_manually_locked,locked_by,locked_at,lock_reason
       ) VALUES
         ($1,$3,'LABORATORY','2096-09-10','PENDING',TRUE,$4,$5,$6,$6,
          $7,CASE WHEN $7 THEN $6::uuid END,CASE WHEN $7 THEN clock_timestamp() END,
          CASE WHEN $7 THEN 'Protected OVPSA fixture' END),
         ($2,$3,'PHYSICAL_EXAM','2096-09-11','PENDING',TRUE,$4,$5,$6,$6,
          FALSE,NULL,NULL,NULL)
       RETURNING id::text,schedule_type`,
      [
        TEST_REFERENCE_IDS.laboratoryClinic,
        TEST_REFERENCE_IDS.physicalExamClinic,
        studentNumber,
        pairId,
        cycleStart,
        TEST_REFERENCE_IDS.adminUser,
        options.manuallyLocked ?? false,
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
      cycleStart,
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
       ($1,$2,$4,'LABORATORY','2096-09-10','SCHEDULED',$5,$6),
       ($1,$3,$4,'PHYSICAL_EXAM','2096-09-11','SCHEDULED',$5,$6)
     RETURNING id::text,schedule_type`,
    [
      batch.rows[0].id,
      TEST_REFERENCE_IDS.laboratoryClinic,
      TEST_REFERENCE_IDS.physicalExamClinic,
      studentNumber,
      sourceRowOrder,
      cycleStart,
    ],
  );
  const itemByService = new Map(items.rows.map((item) => [item.schedule_type, item.id]));
  const appointments = await pool.query<{ id: string; schedule_type: string }>(
    `INSERT INTO appointments (
       batch_id,schedule_item_id,clinic_id,student_number,schedule_type,
       appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start,
       created_by,updated_by,is_manually_locked,locked_by,locked_at,lock_reason
     ) VALUES
       ($1,$2,$4,$6,'LABORATORY','2096-09-10','PENDING',TRUE,$7,$8,$9,$9,
        $10,CASE WHEN $10 THEN $9::uuid END,CASE WHEN $10 THEN clock_timestamp() END,
        CASE WHEN $10 THEN 'Protected OVPSA fixture' END),
       ($1,$3,$5,$6,'PHYSICAL_EXAM','2096-09-11','PENDING',TRUE,$7,$8,$9,$9,
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
      cycleStart,
      TEST_REFERENCE_IDS.adminUser,
      options.manuallyLocked ?? false,
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

  it("reports protected and unknown-lineage conflicts without reserving dates", async () => {
    await insertStudent(`${studentPrefix}0200`, 1);
    await insertLowerPriorityConflict(
      `${studentPrefix}0201`,
      "REGULAR",
      1,
      { manuallyLocked: true },
    );
    await insertLowerPriorityConflict(
      `${studentPrefix}0202`,
      "REGULAR",
      2,
      { withLineage: false },
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
      "UNKNOWN_SCHEDULING_LINEAGE",
    ]);
    const reservations = await pool.query(
      "SELECT 1 FROM ovpsa_first_year_service_reservations WHERE batch_id=$1",
      [created.batchId],
    );
    expect(reservations.rowCount).toBe(0);
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

    const manualCases = await pool.query<{ id: string; optimistic_token: string }>(
      `SELECT id::text,optimistic_token::text FROM clinic_closure_manual_cases
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
