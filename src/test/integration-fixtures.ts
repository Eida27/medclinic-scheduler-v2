import { pool, transaction } from "@/server/db/pool";

export const TEST_REFERENCE_IDS = {
  adminUser: "00000000-0000-4000-8000-000000000001",
  clinicStaffUser: "00000000-0000-4000-8000-000000000002",
  college: "10000000-0000-4000-8000-000000000003",
  program: "20000000-0000-4000-8000-000000000003",
  regularPriority: "30000000-0000-4000-8000-000000000004",
  laboratoryClinic: "60000000-0000-4000-8000-000000000001",
  physicalExamClinic: "60000000-0000-4000-8000-000000000002",
} as const;

type TestStudent = {
  studentNumber: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
  yearLevel: number | null;
};

export async function insertTestStudent({
  studentNumber,
  firstName,
  middleName = null,
  lastName,
  suffix = null,
  yearLevel,
}: TestStudent) {
  await pool.query(
    `INSERT INTO students (
       student_number, first_name, middle_name, last_name, suffix,
       college_id, program_id, year_level
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      studentNumber,
      firstName,
      middleName,
      lastName,
      suffix,
      TEST_REFERENCE_IDS.college,
      TEST_REFERENCE_IDS.program,
      yearLevel,
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
       SELECT student_number FROM students WHERE student_number LIKE $1`,
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
    await client.query(
      "DELETE FROM appointment_status_logs WHERE appointment_id IN (SELECT id FROM test_fixture_appointments)",
    );
    await client.query(
      "DELETE FROM appointments WHERE id IN (SELECT id FROM test_fixture_appointments)",
    );
    await client.query(
      `DELETE FROM coordinator_schedule_items
        WHERE batch_id IN (SELECT id FROM test_fixture_batches)
           OR student_number IN (SELECT student_number FROM test_fixture_students)`,
    );
    await client.query("DELETE FROM schedule_batches WHERE id IN (SELECT id FROM test_fixture_batches)");
    await client.query("DELETE FROM schedule_import_groups WHERE id IN (SELECT id FROM test_fixture_import_groups)");
    await client.query("DELETE FROM students WHERE student_number IN (SELECT student_number FROM test_fixture_students)");
  });
}
