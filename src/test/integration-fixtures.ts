import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "@/server/db/pool";

export const TEST_REFERENCE_IDS = {
  adminUser: "00000000-0000-4000-8000-000000000001",
  clinicStaffUser: "00000000-0000-4000-8000-000000000002",
  coordinatorUser: "00000000-0000-4000-8000-000000000003",
  college: "10000000-0000-4000-8000-000000000003",
  program: "20000000-0000-4000-8000-000000000003",
  laboratoryClinic: "60000000-0000-4000-8000-000000000001",
  physicalExamClinic: "60000000-0000-4000-8000-000000000002",
} as const;

type TestScheduleImportGroup = {
  name: string;
  sourceFilename?: string;
  filename?: string;
  academicYearStart: number;
  importMode: "STANDARD" | "FIRST_YEAR_OVPSA";
  id?: string;
  acceptedAt?: string | Date;
  actor: string;
};

export async function insertTestScheduleImportGroup(
  client: PoolClient,
  input: TestScheduleImportGroup,
) {
  const sourceFilename = input.sourceFilename ?? input.filename;
  if (!sourceFilename) {
    throw new Error("A test schedule import group requires sourceFilename.");
  }
  const result = await client.query<{ id: string }>(
    `INSERT INTO schedule_import_groups (
       id,import_name,source_filename,total_rows,matched_student_count,description,
       created_by,student_category,academic_year_start,preferred_month,accepted_at,
       import_mode,first_year_laboratory_date
     ) VALUES (
       COALESCE($1::uuid,gen_random_uuid()),$2,$3,1,0,$4,$5,'REGULAR',$6,NULL,
       COALESCE($7::timestamptz,clock_timestamp()),$8::varchar,
       CASE WHEN $8::varchar='FIRST_YEAR_OVPSA' THEN make_date($6,9,1) ELSE NULL END
     ) RETURNING id::text AS id`,
    [
      input.id ?? null,
      input.name,
      sourceFilename,
      `Integration fixture import group: ${input.name}`,
      input.actor,
      input.academicYearStart,
      input.acceptedAt ?? null,
      input.importMode,
    ],
  );
  return result.rows[0].id;
}

export async function insertTestAcademicSnapshot(client: PoolClient, input: {
  studentNumber: string;
  academicYearStart: number;
  importName: string;
  actor: string;
  importMode?: "STANDARD" | "FIRST_YEAR_OVPSA";
}) {
  const existing = await client.query<{ id: string }>(
    `SELECT id::text FROM student_academic_snapshots
      WHERE student_number=$1 AND academic_year_start=$2`,
    [input.studentNumber, input.academicYearStart],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const importId = await insertTestScheduleImportGroup(client, {
    name: input.importName,
    sourceFilename: `${randomUUID()}.csv`,
    academicYearStart: input.academicYearStart,
    importMode: input.importMode ?? "STANDARD",
    actor: input.actor,
  });
  const snapshot = await client.query<{ id: string }>(
    `INSERT INTO student_academic_snapshots
      (student_number,academic_year_start,student_name,college_id,college_name,
       program_id,program_code,program_name,year_level,source_import_group_id)
     SELECT student.student_number,$2,
            CONCAT_WS(' ',student.first_name,student.middle_name,student.last_name,student.suffix),
            student.college_id,college.name,student.program_id,program.code,program.name,
            student.year_level,$3
       FROM students student
       JOIN colleges college ON college.id=student.college_id
       JOIN programs program ON program.id=student.program_id
      WHERE student.student_number=$1 RETURNING id::text`,
    [input.studentNumber, input.academicYearStart, importId],
  );
  if (!snapshot.rows[0]) throw new Error(`Test student ${input.studentNumber} was not found.`);
  return snapshot.rows[0].id;
}

type TestStudent = {
  studentNumber: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
  yearLevel: number | null;
  dateOfBirth?: string | null;
};

export async function insertTestStudent({
  studentNumber,
  firstName,
  middleName = null,
  lastName,
  suffix = null,
  yearLevel,
  dateOfBirth = null,
}: TestStudent) {
  await pool.query(
    `INSERT INTO students (
       student_number, first_name, middle_name, last_name, suffix,
       college_id, program_id, year_level, date_of_birth
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      studentNumber,
      firstName,
      middleName,
      lastName,
      suffix,
      TEST_REFERENCE_IDS.college,
      TEST_REFERENCE_IDS.program,
      yearLevel,
      dateOfBirth,
    ],
  );
}

export async function insertNumberedTestStudents(prefix: string, count: number) {
  const studentNumbers = Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index + 1).padStart(4, "0")}`,
  );
  await pool.query(
    `INSERT INTO students (
       student_number, first_name, last_name, college_id, program_id, year_level, section
     )
     SELECT student_number, 'Student', LPAD(position::text, 4, '0'), $2, $3,
            CASE WHEN position <= 40 THEN 4 ELSE ((position - 1) % 4) + 1 END,
            'TEST'
       FROM UNNEST($1::varchar[]) WITH ORDINALITY AS fixture(student_number, position)`,
    [studentNumbers, TEST_REFERENCE_IDS.college, TEST_REFERENCE_IDS.program],
  );
  return studentNumbers;
}

export async function cleanupTestFixtures(
  studentNumberPattern: string,
  batchNamePattern: string,
  importNamePattern?: string,
) {
  await transaction(async (client) => {
    await client.query(
      `CREATE TEMP TABLE test_fixture_students ON COMMIT DROP AS
       SELECT student_number FROM students WHERE student_number LIKE $1
       UNION
       SELECT student_number
         FROM student_academic_snapshots
        WHERE student_number LIKE $1`,
      [studentNumberPattern],
    );
    await client.query("ALTER TABLE test_fixture_students ADD PRIMARY KEY (student_number)");

    await client.query(
      `CREATE TEMP TABLE test_fixture_import_groups ON COMMIT DROP AS
       SELECT id
         FROM schedule_import_groups
        WHERE $1::text IS NOT NULL AND import_name LIKE $1`,
      [importNamePattern ?? null],
    );
    await client.query("ALTER TABLE test_fixture_import_groups ADD PRIMARY KEY (id)");

    await client.query(
      `CREATE TEMP TABLE test_fixture_batches ON COMMIT DROP AS
       SELECT id
         FROM schedule_batches
        WHERE batch_name LIKE $1
           OR import_group_id IN (SELECT id FROM test_fixture_import_groups)`,
      [batchNamePattern],
    );
    await client.query("ALTER TABLE test_fixture_batches ADD PRIMARY KEY (id)");

    await client.query(
      `CREATE TEMP TABLE test_fixture_appointments ON COMMIT DROP AS
       WITH RECURSIVE fixture_appointments AS (
         SELECT appointment.id
           FROM appointments appointment
          WHERE appointment.batch_id IN (SELECT id FROM test_fixture_batches)
             OR appointment.student_number IN (SELECT student_number FROM test_fixture_students)
         UNION
         SELECT child.id
           FROM appointments child
           JOIN fixture_appointments parent ON parent.id=child.rescheduled_from
       )
       SELECT id FROM fixture_appointments`,
    );
    await client.query("ALTER TABLE test_fixture_appointments ADD PRIMARY KEY (id)");
    await client.query(`CREATE TEMP TABLE test_fixture_ovpsa_batches ON COMMIT DROP AS
      SELECT DISTINCT ovpsa_batch_id AS id FROM appointments
      WHERE id IN (SELECT id FROM test_fixture_appointments) AND ovpsa_batch_id IS NOT NULL`);
    const sharedOvpsaMembers = await client.query(`SELECT 1 FROM ovpsa_first_year_membership_snapshots
      WHERE batch_id IN (SELECT id FROM test_fixture_ovpsa_batches)
        AND student_number NOT IN (SELECT student_number FROM test_fixture_students) LIMIT 1`);
    if (sharedOvpsaMembers.rowCount) throw new Error("Refusing cleanup of a partially owned OVPSA batch");
    await client.query(`INSERT INTO test_fixture_import_groups SELECT source_import_group_id
      FROM ovpsa_first_year_batches WHERE id IN (SELECT id FROM test_fixture_ovpsa_batches)
        AND source_import_group_id IS NOT NULL
      ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO test_fixture_batches SELECT id FROM schedule_batches
      WHERE import_group_id IN (SELECT id FROM test_fixture_import_groups) ON CONFLICT DO NOTHING`);

    await client.query(
      `DELETE FROM audit_logs audit
        WHERE (audit.entity_type='schedule_import_group'
               AND audit.entity_id IN (SELECT id::text FROM test_fixture_import_groups))
           OR (audit.entity_type='schedule_batch'
               AND audit.entity_id IN (SELECT id::text FROM test_fixture_batches))
           OR (audit.entity_type='student'
               AND audit.entity_id IN (SELECT student_number FROM test_fixture_students))
           OR (audit.entity_type='appointment'
               AND audit.entity_id IN (SELECT id::text FROM test_fixture_appointments))
           OR (audit.entity_type='student_academic_snapshot' AND (
                SPLIT_PART(COALESCE(audit.entity_id,''),':',1)
                  IN (SELECT student_number FROM test_fixture_students)
                OR EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements(
                      CASE
                        WHEN jsonb_typeof(audit.metadata->'conflicts')='array'
                          THEN audit.metadata->'conflicts'
                        ELSE '[]'::jsonb
                      END
                    ) metadata_conflict
                    JOIN test_fixture_students fixture_student
                      ON fixture_student.student_number=metadata_conflict->>'studentNumber'
                )
              ))
           OR audit.metadata->>'studentNumber' IN (SELECT student_number FROM test_fixture_students)
           OR audit.metadata->>'batchId' IN (SELECT id::text FROM test_fixture_batches)
           OR audit.metadata->>'replacementId' IN (SELECT id::text FROM test_fixture_appointments)
           OR EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(audit.metadata->'batchIds')='array' THEN audit.metadata->'batchIds'
                   ELSE '[]'::jsonb
                 END
               ) AS metadata_batch(id)
               JOIN test_fixture_batches fixture_batch ON fixture_batch.id::text=metadata_batch.id
           )`,
    );
    await client.query("ALTER TABLE laboratory_checklist_events DISABLE TRIGGER laboratory_checklist_events_immutable");
    await client.query("ALTER TABLE laboratory_checklist_appointments DISABLE TRIGGER laboratory_checklist_links_immutable");
    await client.query("ALTER TABLE laboratory_checklists DISABLE TRIGGER laboratory_checklist_identity_immutable");
    await client.query("ALTER TABLE clinical_mutation_requests DISABLE TRIGGER clinical_mutation_requests_immutable");
    await client.query("ALTER TABLE medical_certificate_revisions DISABLE TRIGGER medical_certificate_revision_immutable");
    await client.query("ALTER TABLE medical_certificate_events DISABLE TRIGGER medical_certificate_events_immutable");
    await client.query(`DELETE FROM clinical_mutation_requests WHERE outcome->>'appointmentId' IN
      (SELECT id::text FROM test_fixture_appointments)`);
    await client.query(`DELETE FROM medical_certificate_events WHERE revision_id IN
      (SELECT id FROM medical_certificate_revisions WHERE appointment_id IN
        (SELECT id FROM test_fixture_appointments))`);
    await client.query(`DELETE FROM medical_certificate_revisions WHERE appointment_id IN
      (SELECT id FROM test_fixture_appointments)`);
    await client.query(
      `DELETE FROM student_result_submissions
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)
           OR appointment_id IN (SELECT id FROM test_fixture_appointments)`,
    );
    await client.query(
      `DELETE FROM student_portal_notifications
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)`,
    );
    await client.query(
      `DELETE FROM student_email_verifications
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)`,
    );
    await client.query(
      `DELETE FROM email_outbox
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)`,
    );
    await client.query(
      `DELETE FROM student_login_attempts
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)`,
    );
    await client.query(
      `DELETE FROM exam_results
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)
           OR appointment_id IN (SELECT id FROM test_fixture_appointments)`,
    );
    await client.query(
      `DELETE FROM laboratory_results
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)
           OR appointment_id IN (SELECT id FROM test_fixture_appointments)`,
    );
    await client.query(`DELETE FROM laboratory_checklist_events
      WHERE appointment_id IN (SELECT id FROM test_fixture_appointments)`);
    await client.query(`DELETE FROM laboratory_checklist_items WHERE checklist_id IN
      (SELECT checklist_id FROM laboratory_checklist_appointments WHERE appointment_id IN
        (SELECT id FROM test_fixture_appointments))`);
    await client.query(`DELETE FROM laboratory_checklist_appointments
      WHERE appointment_id IN (SELECT id FROM test_fixture_appointments)`);
    await client.query(`DELETE FROM laboratory_checklists
      WHERE root_appointment_id IN (SELECT id FROM test_fixture_appointments)`);
    await client.query(
      "DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM test_fixture_appointments)",
    );
    await client.query("ALTER TABLE ovpsa_external_laboratory_verifications DISABLE TRIGGER ovpsa_external_laboratory_verifications_immutable");
    await client.query("DELETE FROM ovpsa_external_laboratory_verifications WHERE batch_id IN (SELECT id FROM test_fixture_ovpsa_batches)");
    await client.query("ALTER TABLE ovpsa_external_laboratory_verifications ENABLE TRIGGER ovpsa_external_laboratory_verifications_immutable");
    await client.query(
      "DELETE FROM appointments WHERE id IN (SELECT id FROM test_fixture_appointments)",
    );
    await client.query(
      `DELETE FROM coordinator_schedule_items
        WHERE batch_id IN (SELECT id FROM test_fixture_batches)
           OR student_number IN (SELECT student_number FROM test_fixture_students)`,
    );
    await client.query("DELETE FROM schedule_batches WHERE id IN (SELECT id FROM test_fixture_batches)");
    await client.query("DELETE FROM ovpsa_first_year_active_memberships WHERE batch_id IN (SELECT id FROM test_fixture_ovpsa_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots DISABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_membership_snapshots WHERE batch_id IN (SELECT id FROM test_fixture_ovpsa_batches)");
    await client.query("ALTER TABLE ovpsa_first_year_membership_snapshots ENABLE TRIGGER ovpsa_first_year_membership_snapshots_immutable");
    await client.query("DELETE FROM ovpsa_first_year_service_reservations WHERE batch_id IN (SELECT id FROM test_fixture_ovpsa_batches)");
    await client.query("UPDATE ovpsa_first_year_batches SET current_revision_id=NULL WHERE id IN (SELECT id FROM test_fixture_ovpsa_batches)");
    await client.query("DELETE FROM ovpsa_first_year_batch_revisions WHERE batch_id IN (SELECT id FROM test_fixture_ovpsa_batches)");
    await client.query("DELETE FROM ovpsa_first_year_batches WHERE id IN (SELECT id FROM test_fixture_ovpsa_batches)");
    await client.query(
      "ALTER TABLE student_academic_snapshots DISABLE TRIGGER student_academic_snapshots_immutable",
    );
    await client.query(
      `DELETE FROM student_academic_snapshots
        WHERE student_number IN (SELECT student_number FROM test_fixture_students)`,
    );
    await client.query(
      "ALTER TABLE student_academic_snapshots ENABLE TRIGGER student_academic_snapshots_immutable",
    );
    await client.query("DELETE FROM schedule_import_groups WHERE id IN (SELECT id FROM test_fixture_import_groups)");
    await client.query("DELETE FROM students WHERE student_number IN (SELECT student_number FROM test_fixture_students)");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("ALTER TABLE laboratory_checklist_events ENABLE TRIGGER laboratory_checklist_events_immutable");
    await client.query("ALTER TABLE laboratory_checklist_appointments ENABLE TRIGGER laboratory_checklist_links_immutable");
    await client.query("ALTER TABLE laboratory_checklists ENABLE TRIGGER laboratory_checklist_identity_immutable");
    await client.query("ALTER TABLE clinical_mutation_requests ENABLE TRIGGER clinical_mutation_requests_immutable");
    await client.query("ALTER TABLE medical_certificate_revisions ENABLE TRIGGER medical_certificate_revision_immutable");
    await client.query("ALTER TABLE medical_certificate_events ENABLE TRIGGER medical_certificate_events_immutable");
  });
}
