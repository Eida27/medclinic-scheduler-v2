CREATE TABLE schedule_import_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_name VARCHAR(150) NOT NULL,
  source_filename VARCHAR(255) NOT NULL,
  total_rows INTEGER NOT NULL CHECK (total_rows > 0),
  created_student_count INTEGER NOT NULL DEFAULT 0 CHECK (created_student_count >= 0),
  matched_student_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_student_count >= 0),
  submitted_by_name VARCHAR(150),
  description TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER schedule_import_groups_updated_at
  BEFORE UPDATE ON schedule_import_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE schedule_batches
  ADD COLUMN import_group_id UUID REFERENCES schedule_import_groups(id);

CREATE INDEX batches_import_group_status_idx
  ON schedule_batches (import_group_id, status);

CREATE UNIQUE INDEX batches_import_group_clinic_unique
  ON schedule_batches (import_group_id, clinic_id)
  WHERE import_group_id IS NOT NULL;

-- Snapshot only the known development fixtures and their dependencies so that
-- audit cleanup remains narrow after the domain rows have been deleted.
CREATE TEMP TABLE migration_006_known_demo_batches (
  id UUID PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO migration_006_known_demo_batches (id)
VALUES
  ('50000000-0000-4000-8000-000000000120'),
  ('50000000-0000-4000-8000-000000000130'),
  ('50000000-0000-4000-8000-000000000160'),
  ('50000000-0000-4000-8000-000000000010'),
  ('50000000-0000-4000-8000-000000000011');

CREATE TEMP TABLE migration_006_demo_schedule_items
ON COMMIT DROP
AS
SELECT item.id
  FROM coordinator_schedule_items item
 WHERE item.batch_id IN (SELECT id FROM migration_006_known_demo_batches)
    OR item.student_number LIKE 'DEMO-%';

ALTER TABLE migration_006_demo_schedule_items ADD PRIMARY KEY (id);

CREATE TEMP TABLE migration_006_demo_appointments
ON COMMIT DROP
AS
WITH RECURSIVE doomed_appointments AS (
  SELECT appointment.id
    FROM appointments appointment
   WHERE appointment.batch_id IN (SELECT id FROM migration_006_known_demo_batches)
      OR appointment.student_number LIKE 'DEMO-%'
      OR appointment.schedule_item_id IN (SELECT id FROM migration_006_demo_schedule_items)

  UNION

  SELECT child.id
    FROM appointments child
    JOIN doomed_appointments parent ON parent.id = child.rescheduled_from
)
SELECT id FROM doomed_appointments;

ALTER TABLE migration_006_demo_appointments ADD PRIMARY KEY (id);

CREATE TEMP TABLE migration_006_demo_exam_results
ON COMMIT DROP
AS
SELECT result.id
  FROM exam_results result
 WHERE result.student_number LIKE 'DEMO-%'
    OR result.appointment_id IN (SELECT id FROM migration_006_demo_appointments);

ALTER TABLE migration_006_demo_exam_results ADD PRIMARY KEY (id);

CREATE TEMP TABLE migration_006_demo_laboratory_results
ON COMMIT DROP
AS
SELECT result.id
  FROM laboratory_results result
 WHERE result.student_number LIKE 'DEMO-%'
    OR result.appointment_id IN (SELECT id FROM migration_006_demo_appointments);

ALTER TABLE migration_006_demo_laboratory_results ADD PRIMARY KEY (id);

DELETE FROM audit_logs audit
 WHERE (audit.entity_type = 'schedule_batch'
        AND audit.entity_id IN (SELECT id::text FROM migration_006_known_demo_batches))
    OR (audit.entity_type = 'student' AND audit.entity_id LIKE 'DEMO-%')
    OR (audit.entity_type = 'appointment'
        AND audit.entity_id IN (SELECT id::text FROM migration_006_demo_appointments))
    OR (audit.entity_type = 'physical_exam'
        AND audit.entity_id IN (SELECT id::text FROM migration_006_demo_exam_results))
    OR (audit.entity_type = 'laboratory'
        AND audit.entity_id IN (SELECT id::text FROM migration_006_demo_laboratory_results))
    OR audit.metadata->>'studentNumber' LIKE 'DEMO-%'
    OR audit.metadata->>'batchId' IN (SELECT id::text FROM migration_006_known_demo_batches)
    OR audit.metadata->>'replacementId' IN (SELECT id::text FROM migration_006_demo_appointments)
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(audit.metadata->'batchIds') = 'array' THEN audit.metadata->'batchIds'
            ELSE '[]'::jsonb
          END
        ) AS metadata_batch(id)
        JOIN migration_006_known_demo_batches known_batch
          ON known_batch.id::text = metadata_batch.id
    );

DELETE FROM appointment_status_logs
 WHERE appointment_id IN (SELECT id FROM migration_006_demo_appointments);

DELETE FROM exam_results
 WHERE id IN (SELECT id FROM migration_006_demo_exam_results);

DELETE FROM laboratory_results
 WHERE id IN (SELECT id FROM migration_006_demo_laboratory_results);

DELETE FROM appointments
 WHERE id IN (SELECT id FROM migration_006_demo_appointments);

DELETE FROM coordinator_schedule_items
 WHERE id IN (SELECT id FROM migration_006_demo_schedule_items);

DELETE FROM schedule_batches
 WHERE id IN (SELECT id FROM migration_006_known_demo_batches);

DELETE FROM students
 WHERE student_number LIKE 'DEMO-%';
