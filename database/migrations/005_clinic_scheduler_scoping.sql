CREATE TABLE IF NOT EXISTS clinics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(150) UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clinics_code_normalized CHECK (code = UPPER(code))
);

INSERT INTO clinics (id, code, name)
VALUES
  ('60000000-0000-4000-8000-000000000001', 'KABALAKA_CLINIC', 'KABALAKA Clinic'),
  ('60000000-0000-4000-8000-000000000002', 'CPU_CLINIC', 'CPU Clinic')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

ALTER TABLE users ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id);
ALTER TABLE clinic_capacity_settings ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id);
ALTER TABLE schedule_batches ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id);
ALTER TABLE coordinator_schedule_items ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS clinic_id UUID REFERENCES clinics(id);

UPDATE users
   SET clinic_id = '60000000-0000-4000-8000-000000000001'
 WHERE role = 'CLINIC_STAFF'
   AND clinic_id IS NULL;

UPDATE clinic_capacity_settings
   SET clinic_id = CASE schedule_type
     WHEN 'LABORATORY' THEN '60000000-0000-4000-8000-000000000001'::uuid
     ELSE '60000000-0000-4000-8000-000000000002'::uuid
   END
 WHERE clinic_id IS NULL;

UPDATE coordinator_schedule_items
   SET clinic_id = CASE schedule_type
     WHEN 'LABORATORY' THEN '60000000-0000-4000-8000-000000000001'::uuid
     ELSE '60000000-0000-4000-8000-000000000002'::uuid
   END
 WHERE clinic_id IS NULL
   AND schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY');

INSERT INTO coordinator_schedule_items (
  batch_id, clinic_id, student_number, schedule_type, priority_group_id,
  target_date, target_week_start, target_week_end, remarks, status, validation_issues,
  created_at, updated_at
)
SELECT
  batch_id,
  '60000000-0000-4000-8000-000000000001',
  student_number,
  'LABORATORY',
  priority_group_id,
  target_date,
  target_week_start,
  target_week_end,
  remarks,
  status,
  validation_issues,
  created_at,
  updated_at
FROM coordinator_schedule_items
WHERE schedule_type = 'BOTH'
ON CONFLICT DO NOTHING;

UPDATE coordinator_schedule_items
   SET schedule_type = 'PHYSICAL_EXAM',
       clinic_id = '60000000-0000-4000-8000-000000000002'
 WHERE schedule_type = 'BOTH';

UPDATE appointments
   SET clinic_id = CASE schedule_type
     WHEN 'LABORATORY' THEN '60000000-0000-4000-8000-000000000001'::uuid
     ELSE '60000000-0000-4000-8000-000000000002'::uuid
   END
 WHERE clinic_id IS NULL;

DO $$
DECLARE
  batch RECORD;
  first_clinic UUID;
  split_clinic RECORD;
  new_batch_id UUID;
BEGIN
  FOR batch IN SELECT id FROM schedule_batches LOOP
    SELECT clinic_id INTO first_clinic
      FROM coordinator_schedule_items
     WHERE batch_id = batch.id
     GROUP BY clinic_id
     ORDER BY clinic_id
     LIMIT 1;

    IF first_clinic IS NULL THEN
      first_clinic := '60000000-0000-4000-8000-000000000002';
    END IF;

    UPDATE schedule_batches SET clinic_id = first_clinic WHERE id = batch.id;

    FOR split_clinic IN
      SELECT DISTINCT i.clinic_id, c.name AS clinic_name
        FROM coordinator_schedule_items i
        JOIN clinics c ON c.id = i.clinic_id
       WHERE i.batch_id = batch.id
         AND i.clinic_id <> first_clinic
    LOOP
      INSERT INTO schedule_batches (
        clinic_id, batch_name, college_id, program_id, submitted_by_name, description,
        status, validation_summary, validated_by, validated_at, created_by, published_by,
        published_at, override_reason, overridden_by, overridden_at, created_at, updated_at
      )
      SELECT
        split_clinic.clinic_id,
        batch_name || ' - ' || split_clinic.clinic_name,
        college_id,
        program_id,
        submitted_by_name,
        description,
        status,
        validation_summary,
        validated_by,
        validated_at,
        created_by,
        published_by,
        published_at,
        override_reason,
        overridden_by,
        overridden_at,
        created_at,
        updated_at
      FROM schedule_batches
      WHERE id = batch.id
      RETURNING id INTO new_batch_id;

      UPDATE coordinator_schedule_items
         SET batch_id = new_batch_id
       WHERE batch_id = batch.id
         AND clinic_id = split_clinic.clinic_id;

      UPDATE appointments
         SET batch_id = new_batch_id
       WHERE batch_id = batch.id
         AND clinic_id = split_clinic.clinic_id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE clinic_capacity_settings ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE schedule_batches ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE coordinator_schedule_items ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE appointments ALTER COLUMN clinic_id SET NOT NULL;

ALTER TABLE coordinator_schedule_items DROP CONSTRAINT IF EXISTS coordinator_schedule_items_schedule_type_check;
ALTER TABLE coordinator_schedule_items DROP CONSTRAINT IF EXISTS coordinator_schedule_items_schedule_type_service_check;
ALTER TABLE coordinator_schedule_items
  ADD CONSTRAINT coordinator_schedule_items_schedule_type_service_check
  CHECK (schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY'));

ALTER TABLE clinic_capacity_settings DROP CONSTRAINT IF EXISTS clinic_capacity_settings_schedule_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS clinic_capacity_settings_clinic_type_unique
  ON clinic_capacity_settings (clinic_id, schedule_type);

DROP INDEX IF EXISTS appointments_one_active_service_idx;
CREATE UNIQUE INDEX appointments_one_active_service_idx
  ON appointments (student_number, clinic_id, schedule_type)
  WHERE status IN ('DRAFT', 'PENDING');

CREATE INDEX IF NOT EXISTS batches_clinic_status_idx
  ON schedule_batches (clinic_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS schedule_items_clinic_batch_idx
  ON coordinator_schedule_items (batch_id, clinic_id, status);
CREATE INDEX IF NOT EXISTS appointments_clinic_date_service_idx
  ON appointments (clinic_id, appointment_date, schedule_type, status);
