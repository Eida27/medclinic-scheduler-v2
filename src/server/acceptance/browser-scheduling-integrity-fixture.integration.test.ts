import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEDULING_INTEGRITY_FIXTURE,
  assertSafeSchedulingIntegrityStatus,
  runSchedulingIntegrityFixtureOperation,
} from "../../../scripts/browser-scheduling-integrity-fixture";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const exclusiveFlag = "1";

async function operation<TMode extends "setup" | "status" | "cleanup">(mode: TMode) {
  return runSchedulingIntegrityFixtureOperation({
    mode,
    databaseUrl,
    exclusiveFlag,
  });
}

describe.sequential("scheduling integrity guarded fixture workflow", () => {
  afterEach(async () => {
    await operation("cleanup");
  });

  it("detects dynamic retired-route rows and cleans the exact owned namespace", async () => {
    await operation("cleanup");
    const setup = await operation("setup");
    expect(setup).toMatchObject({
      mode: "setup",
      phase: "PREPARED",
      preparedCounts: {
        users: 2,
        coreStudents: 5,
        capacityStudents: 150,
        pairAppointments: 9,
        capacityAppointments: 150,
        importGroups: 1,
        scheduleBatches: 3,
        scheduleItems: 3,
      },
    });
    expect(() => assertSafeSchedulingIntegrityStatus(setup)).not.toThrow();

    const initialStatus = await operation("status");
    expect(initialStatus).toMatchObject({
      mode: "status",
      phase: "PREPARED",
      retiredRouteSentinel: { unchanged: true },
    });
    expect(() => assertSafeSchedulingIntegrityStatus(initialStatus)).not.toThrow();

    const dynamicImportGroupId = randomUUID();
    const dynamicBatchId = randomUUID();
    const dynamicItemId = randomUUID();
    const unrelatedImportGroupId = randomUUID();
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const unrelatedActor = await pool.query<{ id: string }>(
        "SELECT id::text FROM users WHERE id<>ALL($1::uuid[]) ORDER BY id LIMIT 1",
        [[SCHEDULING_INTEGRITY_FIXTURE.admin.id, SCHEDULING_INTEGRITY_FIXTURE.staff.id]],
      );
      expect(unrelatedActor.rows[0]?.id).toBeTruthy();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO schedule_import_groups (
             id,import_name,source_filename,total_rows,matched_student_count,
             description,created_by,student_category,academic_year_start,accepted_at,import_mode
           ) VALUES
             ($1,$2::varchar,'dynamic-retired-route.csv',1,1,$2::text,$3,
              'REGULAR',2026,clock_timestamp(),'STANDARD'),
             ($4,'Unrelated integration sentinel','unrelated-integration.csv',1,1,NULL,$5,
              'REGULAR',2026,clock_timestamp(),'STANDARD')`,
          [
            dynamicImportGroupId,
            `${SCHEDULING_INTEGRITY_FIXTURE.marker}-DYNAMIC`,
            SCHEDULING_INTEGRITY_FIXTURE.admin.id,
            unrelatedImportGroupId,
            unrelatedActor.rows[0].id,
          ],
        );
        await client.query(
          `INSERT INTO schedule_batches (
             id,clinic_id,batch_name,college_id,program_id,status,created_by,import_group_id,
             description
           ) VALUES ($1,$2,$3::varchar,$4,$5,'DRAFT',$6,$7,$3::text)`,
          [
            dynamicBatchId,
            "60000000-0000-4000-8000-000000000001",
            `${SCHEDULING_INTEGRITY_FIXTURE.marker}-DYNAMIC`,
            SCHEDULING_INTEGRITY_FIXTURE.ids.college,
            SCHEDULING_INTEGRITY_FIXTURE.ids.program,
            SCHEDULING_INTEGRITY_FIXTURE.admin.id,
            dynamicImportGroupId,
          ],
        );
        await client.query(
          `INSERT INTO coordinator_schedule_items (
             id,batch_id,clinic_id,student_number,schedule_type,priority_group_id,
             target_date,remarks,status,source_row_order,schedule_cycle_start
           ) VALUES ($1,$2,$3,$4,'LABORATORY',$5,$6,$7,'PENDING',2,2026)`,
          [
            dynamicItemId,
            dynamicBatchId,
            "60000000-0000-4000-8000-000000000001",
            SCHEDULING_INTEGRITY_FIXTURE.students.legacySentinel.studentNumber,
            SCHEDULING_INTEGRITY_FIXTURE.priorityGroupId,
            "2027-04-22",
            SCHEDULING_INTEGRITY_FIXTURE.marker,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await expect(operation("status")).rejects.toThrow(
        /retired scheduling sentinel changed/i,
      );

      const cleanup = await operation("cleanup");
      expect(cleanup).toMatchObject({
        mode: "cleanup",
        phase: "ABSENT",
      });
      expect(Object.values(cleanup.residue).every((count) => count === 0)).toBe(true);
      const remaining = await pool.query<{ owned_count: number; unrelated_count: number }>(
        `SELECT (
           (SELECT COUNT(*) FROM schedule_import_groups WHERE id=$1)
           + (SELECT COUNT(*) FROM schedule_batches WHERE id=$2)
           + (SELECT COUNT(*) FROM coordinator_schedule_items WHERE id=$3)
         )::int AS owned_count,
         (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=$4) AS unrelated_count`,
        [dynamicImportGroupId, dynamicBatchId, dynamicItemId, unrelatedImportGroupId],
      );
      expect(remaining.rows[0]).toEqual({ owned_count: 0, unrelated_count: 1 });
    } finally {
      await pool.query(
        "DELETE FROM schedule_import_groups WHERE id=$1",
        [unrelatedImportGroupId],
      ).catch(() => undefined);
      await pool.end();
    }
  }, 60_000);
});
