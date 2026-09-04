// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { pool } from "@/server/db/pool";
import {
  completeAppointmentWithClient,
  updateAppointment,
} from "@/server/services/appointments.service";
import { acceptAndScheduleImport } from "@/server/services/schedule-imports.service";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import type { SessionUser } from "@/types/roles";
import { verifyOvpsaExternalLaboratory } from "./external-laboratory-verification.service";

const cycleStart = 2095;
const studentNumber = "95-8899-01";
const cpuStaffUserId = "95000000-0000-4000-8000-000000000001";
const sourceFilename = "TEST-OVPSA-EXTERNAL-LAB.csv";

const admin: SessionUser = {
  userId: TEST_REFERENCE_IDS.adminUser,
  fullName: "Test Admin",
  email: "admin@medclinic.local",
  role: "ADMIN",
  clinicId: null,
  clinicCode: null,
  clinicName: null,
};
const cpuStaff: SessionUser = {
  userId: cpuStaffUserId,
  fullName: "CPU Verification Staff",
  email: "ovpsa-cpu-staff@test.local",
  role: "CLINIC_STAFF",
  clinicId: TEST_REFERENCE_IDS.physicalExamClinic,
  clinicCode: "CPU_CLINIC",
  clinicName: "CPU Clinic",
};

async function cleanup() {
  await pool.query(
    "DELETE FROM audit_logs WHERE metadata->>'studentNumber'=$1 OR entity_id IN (SELECT id::text FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$2) OR entity_id IN (SELECT id::text FROM schedule_import_groups WHERE source_filename=$4) OR actor_user_id=$3",
    [studentNumber, cycleStart, cpuStaffUserId, sourceFilename],
  );
  await pool.query("DELETE FROM email_outbox WHERE student_number=$1", [
    studentNumber,
  ]);
  await pool.query(
    "DELETE FROM student_portal_notifications WHERE student_number=$1",
    [studentNumber],
  );
  await pool.query(
    "ALTER TABLE ovpsa_external_laboratory_verifications DISABLE TRIGGER ovpsa_external_laboratory_verifications_immutable",
  );
  await pool.query(
    "DELETE FROM ovpsa_external_laboratory_verifications WHERE appointment_id IN (SELECT id FROM appointments WHERE student_number=$1)",
    [studentNumber],
  );
  await pool.query(
    "ALTER TABLE ovpsa_external_laboratory_verifications ENABLE TRIGGER ovpsa_external_laboratory_verifications_immutable",
  );
  await pool.query(
    "DELETE FROM appointment_reschedule_events WHERE student_number=$1",
    [studentNumber],
  );
  await pool.query("DELETE FROM laboratory_results WHERE student_number=$1", [
    studentNumber,
  ]);
  await pool.query("DELETE FROM exam_results WHERE student_number=$1", [
    studentNumber,
  ]);
  await pool.query(
    "DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM appointments WHERE student_number=$1)",
    [studentNumber],
  );
  await pool.query("DELETE FROM appointments WHERE student_number=$1", [
    studentNumber,
  ]);
  await pool.query(
    "DELETE FROM ovpsa_first_year_active_memberships WHERE student_number=$1",
    [studentNumber],
  );
  await pool.query(
    "ALTER TABLE ovpsa_first_year_membership_snapshots DISABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable",
  );
  await pool.query(
    "DELETE FROM ovpsa_first_year_membership_snapshots WHERE student_number=$1",
    [studentNumber],
  );
  await pool.query(
    "ALTER TABLE ovpsa_first_year_membership_snapshots ENABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable",
  );
  await pool.query(
    "DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)",
    [cycleStart],
  );
  await pool.query(
    "UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE schedule_cycle_start=$1",
    [cycleStart],
  );
  await pool.query(
    "DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id IN (SELECT id FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1)",
    [cycleStart],
  );
  await pool.query(
    "DELETE FROM ovpsa_first_year_batches WHERE schedule_cycle_start=$1",
    [cycleStart],
  );
  await pool.query(
    "DELETE FROM coordinator_schedule_items WHERE batch_id IN (SELECT id FROM schedule_batches WHERE import_group_id IN (SELECT id FROM schedule_import_groups WHERE source_filename=$1))",
    [sourceFilename],
  );
  await pool.query(
    "DELETE FROM schedule_batches WHERE import_group_id IN (SELECT id FROM schedule_import_groups WHERE source_filename=$1)",
    [sourceFilename],
  );
  await pool.query(
    "ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable",
  );
  await pool.query(
    "DELETE FROM student_academic_snapshots WHERE student_number=$1",
    [studentNumber],
  );
  await pool.query(
    "ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable",
  );
  await pool.query("DELETE FROM schedule_import_groups WHERE source_filename=$1", [sourceFilename]);
  await pool.query("DELETE FROM students WHERE student_number=$1", [
    studentNumber,
  ]);
  await pool.query("DELETE FROM academic_years WHERE start_year=$1", [
    cycleStart,
  ]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(
    `INSERT INTO users (id,full_name,email,password_hash,role,clinic_id)
     VALUES ($1,'CPU Verification Staff','ovpsa-cpu-staff@test.local','fixture','CLINIC_STAFF',$2)
     ON CONFLICT (id) DO NOTHING`,
    [cpuStaffUserId, TEST_REFERENCE_IDS.physicalExamClinic],
  );
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.query("DELETE FROM users WHERE id=$1", [cpuStaffUserId]);
  await pool.end();
});

async function publishFixture() {
  await pool.query(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,'2096-07-31',$2,$2)`,
    [cycleStart, TEST_REFERENCE_IDS.adminUser],
  );
  const contents = [
    "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth",
    `${studentNumber},Laboratory,External,Maria,,College of Computer Studies,BSIT,1,2006-01-01`,
  ].join("\n");
  const published = await acceptAndScheduleImport({
    fileName: sourceFilename,
    fileSize: Buffer.byteLength(contents),
    contents,
    importMode: "FIRST_YEAR_OVPSA",
    studentCategory: "REGULAR",
    academicYearStart: cycleStart,
    preferredMonth: null,
    firstYearLaboratoryDate: "2095-09-01",
  }, admin);
  const batch = await pool.query<{ id: string }>(
    "SELECT id::text FROM ovpsa_first_year_batches WHERE source_import_group_id=$1",
    [published.importId],
  );
  const appointments = await pool.query<{
    id: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    "SELECT id::text,schedule_type FROM appointments WHERE ovpsa_batch_id=$1 ORDER BY schedule_type",
    [batch.rows[0].id],
  );
  const byService = new Map(
    appointments.rows.map((appointment) => [
      appointment.schedule_type,
      appointment.id,
    ]),
  );
  return {
    batchId: batch.rows[0].id,
    laboratoryId: byService.get("LABORATORY")!,
    physicalExamId: byService.get("PHYSICAL_EXAM")!,
  };
}

describe("external First Year Laboratory verification", () => {
  it("guards generic completion, verifies atomically, then permits quick PE completion", async () => {
    const fixture = await publishFixture();
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await expect(
        completeAppointmentWithClient(
          fixture.laboratoryId,
          admin,
          null,
          client,
        ),
      ).rejects.toMatchObject({
        code: "OVPSA_EXTERNAL_LABORATORY_VERIFICATION_REQUIRED",
      });
      await expect(
        completeAppointmentWithClient(
          fixture.physicalExamId,
          admin,
          null,
          client,
        ),
      ).rejects.toMatchObject({
        code: "OVPSA_PHYSICAL_EXAM_REQUIRES_LAB_VERIFICATION",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await expect(
      updateAppointment(
        fixture.physicalExamId,
        {
          quickStatusAction: "MARK_COMPLETED",
          expectedStatus: "PENDING",
        },
        cpuStaff,
      ),
    ).rejects.toMatchObject({
      code: "OVPSA_PHYSICAL_EXAM_REQUIRES_LAB_VERIFICATION",
    });

    await expect(
      verifyOvpsaExternalLaboratory(
        fixture.laboratoryId,
        { remarks: "Original Mission Hospital result reviewed." },
        cpuStaff,
      ),
    ).resolves.toMatchObject({
      appointmentId: fixture.laboratoryId,
      externalProvider: "Iloilo Mission Hospital",
    });

    const verified = await pool.query<{
      appointment_status: string;
      result_status: string;
      provider: string;
      verified_by: string;
    }>(
      `SELECT appointment.status AS appointment_status,result.result_status,
              verification.external_provider AS provider,
              verification.verified_by::text
         FROM appointments appointment
         JOIN laboratory_results result ON result.appointment_id=appointment.id
         JOIN ovpsa_external_laboratory_verifications verification
           ON verification.appointment_id=appointment.id
        WHERE appointment.id=$1`,
      [fixture.laboratoryId],
    );
    expect(verified.rows).toEqual([
      {
        appointment_status: "COMPLETED",
        result_status: "COMPLETED",
        provider: "Iloilo Mission Hospital",
        verified_by: cpuStaffUserId,
      },
    ]);

    await expect(
      updateAppointment(
        fixture.physicalExamId,
        {
          quickStatusAction: "MARK_COMPLETED",
          expectedStatus: "PENDING",
        },
        cpuStaff,
      ),
    ).resolves.toMatchObject({ status: "COMPLETED" });
  });
});
