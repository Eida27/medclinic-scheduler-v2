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
    const dynamicImportGroupId = randomUUID();
    const unrelatedImportGroupId = randomUUID();
    const pool = new Pool({ connectionString: databaseUrl });
    let ownsAcademicYear = false;
    try {
      const academicYearActor = await pool.query<{ id: string }>(
        `SELECT id::text
           FROM users
          WHERE role='ADMIN' AND deleted_at IS NULL
          ORDER BY id
          LIMIT 1`,
      );
      expect(academicYearActor.rows[0]?.id).toBeTruthy();
      const academicYear = await pool.query(
        `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
         VALUES (2026,'2027-07-31',$1,$1)
         ON CONFLICT (start_year) DO NOTHING
         RETURNING start_year`,
        [academicYearActor.rows[0].id],
      );
      ownsAcademicYear = academicYear.rowCount === 1;
      await operation("cleanup");
      const setup = await operation("setup");
      expect(setup).toMatchObject({
        mode: "setup",
        phase: "PREPARED",
        preparedCounts: {
          users: 2,
          coreStudents: 4,
          capacityStudents: 150,
          pairAppointments: 8,
          capacityAppointments: 150,
          importGroups: 1,
          scheduleBatches: 0,
          scheduleItems: 0,
        },
      });
      expect(() => assertSafeSchedulingIntegrityStatus(setup)).not.toThrow();

      const clinicalSetup = await pool.query<{
        snapshots: number;
        checklists: number;
        links: number;
        items: number;
        verified_manual_items: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM student_academic_snapshots
             WHERE source_import_group_id=$1 AND academic_year_start=2026) AS snapshots,
           (SELECT COUNT(*)::int FROM laboratory_checklists
             WHERE root_appointment_id=ANY($2::uuid[])) AS checklists,
           (SELECT COUNT(*)::int FROM laboratory_checklist_appointments
             WHERE appointment_id=ANY($2::uuid[])) AS links,
           (SELECT COUNT(*)::int FROM laboratory_checklist_items item
             JOIN laboratory_checklists checklist ON checklist.id=item.checklist_id
             WHERE checklist.root_appointment_id=ANY($2::uuid[])) AS items,
           (SELECT COUNT(*)::int FROM laboratory_checklist_items item
             JOIN laboratory_checklists checklist ON checklist.id=item.checklist_id
             WHERE checklist.root_appointment_id=$3 AND item.verified_at IS NOT NULL
               AND item.verified_by=$4 AND item.verification_source='INTERNAL') AS verified_manual_items`,
        [
          SCHEDULING_INTEGRITY_FIXTURE.ids.importGroup,
          [
            SCHEDULING_INTEGRITY_FIXTURE.appointmentIds.lifecycleLaboratory,
            SCHEDULING_INTEGRITY_FIXTURE.appointmentIds.manualLaboratory,
            SCHEDULING_INTEGRITY_FIXTURE.appointmentIds.displacementLaboratory,
            SCHEDULING_INTEGRITY_FIXTURE.appointmentIds.portalLaboratory,
          ],
          SCHEDULING_INTEGRITY_FIXTURE.appointmentIds.manualLaboratory,
          SCHEDULING_INTEGRITY_FIXTURE.admin.id,
        ],
      );
      expect(clinicalSetup.rows[0]).toEqual({
        snapshots: 154,
        checklists: 4,
        links: 4,
        items: 12,
        verified_manual_items: 3,
      });

      const initialStatus = await operation("status");
      expect(initialStatus).toMatchObject({
        mode: "status",
        phase: "PREPARED",
        retiredRouteSentinel: { unchanged: true },
      });
      expect(() => assertSafeSchedulingIntegrityStatus(initialStatus)).not.toThrow();

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
      const clinicalResidue = await pool.query<{
        snapshots: number;
        checklists: number;
        links: number;
        items: number;
        events: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM student_academic_snapshots WHERE source_import_group_id=$1) AS snapshots,
           (SELECT COUNT(*)::int FROM laboratory_checklists WHERE student_number LIKE 'B-SIH-%') AS checklists,
           (SELECT COUNT(*)::int FROM laboratory_checklist_appointments link
             JOIN appointments appointment ON appointment.id=link.appointment_id
             WHERE appointment.student_number LIKE 'B-SIH-%') AS links,
           (SELECT COUNT(*)::int FROM laboratory_checklist_items item
             JOIN laboratory_checklists checklist ON checklist.id=item.checklist_id
             WHERE checklist.student_number LIKE 'B-SIH-%') AS items,
           (SELECT COUNT(*)::int FROM laboratory_checklist_events event
             JOIN laboratory_checklists checklist ON checklist.id=event.checklist_id
             WHERE checklist.student_number LIKE 'B-SIH-%') AS events`,
        [SCHEDULING_INTEGRITY_FIXTURE.ids.importGroup],
      );
      expect(Object.values(clinicalResidue.rows[0]).every((count) => count === 0)).toBe(true);
      const remaining = await pool.query<{ owned_count: number; unrelated_count: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=$1) AS owned_count,
           (SELECT COUNT(*)::int FROM schedule_import_groups WHERE id=$2) AS unrelated_count`,
        [dynamicImportGroupId, unrelatedImportGroupId],
      );
      expect(remaining.rows[0]).toEqual({ owned_count: 0, unrelated_count: 1 });
    } finally {
      await operation("cleanup").catch(() => undefined);
      await pool.query(
        "DELETE FROM schedule_import_groups WHERE id=$1",
        [unrelatedImportGroupId],
      ).catch(() => undefined);
      if (ownsAcademicYear) {
        await pool.query(
          "DELETE FROM academic_years WHERE start_year=2026",
        ).catch(() => undefined);
      }
      await pool.end();
    }
  }, 60_000);
});
