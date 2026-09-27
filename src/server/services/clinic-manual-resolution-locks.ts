import "server-only";
import type { PoolClient } from "pg";
import { lockEffectiveAppointmentScopes, lockSchedulingMutationQueue } from "@/server/repositories/effective-appointment-scope-lock.repository";

/** Call once for the complete selection before resolving any member in a transaction. */
export async function lockClinicManualResolutionCases(client: PoolClient, caseIds: string[]) {
  await lockSchedulingMutationQueue(client);
  const ids = [...new Set(caseIds)].sort();
  const scopes = await client.query<{ student_number: string }>(
    "SELECT DISTINCT student_number FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[])",
    [ids],
  );
  await lockEffectiveAppointmentScopes(client, scopes.rows.flatMap((row) => [
    { studentNumber: row.student_number, scheduleType: "LABORATORY" },
    { studentNumber: row.student_number, scheduleType: "PHYSICAL_EXAM" },
  ]));
  await client.query(
    "SELECT id FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [ids],
  );
  // Lock both original and already-created replacements before reading protection/checklists.
  await client.query(
    `SELECT appointment.id FROM appointments appointment
      WHERE appointment.id IN (
        SELECT affected_laboratory_appointment_id FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[])
        UNION SELECT affected_physical_exam_appointment_id FROM clinic_closure_manual_cases WHERE id=ANY($1::uuid[])
        UNION SELECT new_laboratory_appointment_id FROM appointment_reschedule_events WHERE manual_case_id=ANY($1::uuid[])
        UNION SELECT new_physical_exam_appointment_id FROM appointment_reschedule_events WHERE manual_case_id=ANY($1::uuid[])
      ) ORDER BY appointment.id FOR UPDATE`,
    [ids],
  );
}
