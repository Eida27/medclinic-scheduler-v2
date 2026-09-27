import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { requiredLaboratoryTests } from "@/server/laboratory/laboratory-requirements";
import type { LaboratoryTestCode } from "@/server/laboratory/laboratory-requirements";

export type LaboratoryChecklistItem = {
  testCode: LaboratoryTestCode;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  verificationSource: "INTERNAL" | "EXTERNAL" | null;
};

export type LaboratoryChecklistRecord = {
  checklistId: string;
  appointmentId: string;
  version: number;
  appointmentStatus: string;
  items: LaboratoryChecklistItem[];
  verifiedCount: number;
  totalCount: number;
};

export async function loadLaboratoryChecklist(
  client: PoolClient,
  appointmentId: string,
  lock = false,
): Promise<LaboratoryChecklistRecord | null> {
  const checklist = await client.query<{ checklistId: string; version: number; appointmentStatus: string }>(
    `SELECT checklist.id::text AS "checklistId",checklist.version,
            appointment.status AS "appointmentStatus"
       FROM laboratory_checklist_appointments link
       JOIN laboratory_checklists checklist ON checklist.id=link.checklist_id
       JOIN appointments appointment ON appointment.id=link.appointment_id
      WHERE link.appointment_id=$1 ${lock ? "FOR UPDATE OF checklist" : ""}`,
    [appointmentId],
  );
  const row = checklist.rows[0];
  if (!row) return null;
  const items = await client.query<LaboratoryChecklistItem>(
    `SELECT test_code AS "testCode",verified_at AS "verifiedAt",
            verified_by::text AS "verifiedBy",verification_source AS "verificationSource"
       FROM laboratory_checklist_items WHERE checklist_id=$1
      ORDER BY array_position(ARRAY['CBC','URINE','STOOL','XRAY']::varchar[],test_code)
      ${lock ? "FOR UPDATE" : ""}`,
    [row.checklistId],
  );
  return {
    ...row,
    appointmentId,
    items: items.rows,
    verifiedCount: items.rows.filter((item) => item.verifiedAt !== null).length,
    totalCount: items.rows.length,
  };
}

type PublicationRow = {
  id: string;
  scheduleType: string;
  isPublished: boolean;
  rescheduledFrom: string | null;
  studentNumber: string;
  scheduleCycleStart: number | null;
  schedulingCategory: string | null;
  snapshotId: string | null;
  yearLevel: number | null;
};

/** Call within the publication or replacement transaction, before commit. */
export async function linkPublishedLaboratoryAppointments(client: PoolClient, appointmentIds: string[]) {
  if (!appointmentIds.length) return;
  const appointments = await client.query<PublicationRow>(
    `SELECT appointment.id::text, appointment.schedule_type AS "scheduleType",
            appointment.is_published AS "isPublished",
            appointment.rescheduled_from::text AS "rescheduledFrom",
            appointment.student_number AS "studentNumber",
            appointment.schedule_cycle_start AS "scheduleCycleStart",
            appointment.scheduling_category AS "schedulingCategory",
            snapshot.id::text AS "snapshotId",snapshot.year_level AS "yearLevel"
       FROM appointments appointment
       LEFT JOIN student_academic_snapshots snapshot
         ON snapshot.student_number=appointment.student_number
        AND snapshot.academic_year_start=appointment.schedule_cycle_start
      WHERE appointment.id=ANY($1::uuid[]) ORDER BY appointment.id`,
    [appointmentIds],
  );
  if (appointments.rowCount !== new Set(appointmentIds).size) {
    throw new AppError("APPOINTMENT_NOT_FOUND", "A published Laboratory appointment was not found.", 404);
  }
  for (const appointment of appointments.rows) {
    if (!appointment.isPublished || appointment.scheduleType !== "LABORATORY") continue;
    if (appointment.rescheduledFrom) {
      const predecessor = await client.query<{ checklistId: string }>(
        `SELECT checklist_id::text AS "checklistId" FROM laboratory_checklist_appointments WHERE appointment_id=$1`,
        [appointment.rescheduledFrom],
      );
      if (!predecessor.rows[0]) {
        throw new AppError("LABORATORY_LINEAGE_MISSING", "The previous Laboratory appointment has no checklist.", 409);
      }
      await client.query(
        `INSERT INTO laboratory_checklist_appointments (appointment_id,checklist_id) VALUES ($1,$2)
         ON CONFLICT (appointment_id) DO NOTHING`,
        [appointment.id, predecessor.rows[0].checklistId],
      );
      continue;
    }
    const tests = requiredLaboratoryTests({
      yearLevel: appointment.yearLevel,
      schedulingCategory: appointment.schedulingCategory,
    });
    if (!appointment.snapshotId || !appointment.scheduleCycleStart) {
      throw new AppError("LABORATORY_PROVENANCE_MISSING", "The appointment has no academic snapshot.", 409);
    }
    const created = await client.query<{ id: string }>(
      `INSERT INTO laboratory_checklists
        (root_appointment_id,student_number,academic_year_start,academic_snapshot_id,year_level_snapshot,scheduling_category_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (root_appointment_id) DO UPDATE SET version=laboratory_checklists.version
       RETURNING id::text`,
      [appointment.id, appointment.studentNumber, appointment.scheduleCycleStart,
        appointment.snapshotId, appointment.yearLevel, appointment.schedulingCategory],
    );
    const checklistId = created.rows[0].id;
    await client.query(
      `INSERT INTO laboratory_checklist_appointments (appointment_id,checklist_id) VALUES ($1,$2)
       ON CONFLICT (appointment_id) DO NOTHING`,
      [appointment.id, checklistId],
    );
    await client.query(
      `INSERT INTO laboratory_checklist_items (checklist_id,test_code)
       SELECT $1,code FROM unnest($2::varchar[]) code
       ON CONFLICT (checklist_id,test_code) DO NOTHING`,
      [checklistId, tests],
    );
  }
}
