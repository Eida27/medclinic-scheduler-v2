-- Retire only the old generic manual/staged scheduling contract.
-- The migration runner owns the transaction; reject unsupported rows before DDL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schedule_import_groups
    WHERE student_category IS NULL OR academic_year_start IS NULL
  ) OR EXISTS (
    SELECT 1 FROM schedule_batches
    WHERE status NOT IN ('PUBLISHED', 'CANCELLED')
       OR override_reason IS NOT NULL OR overridden_by IS NOT NULL OR overridden_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM coordinator_schedule_items
    WHERE target_date IS NULL OR status <> 'SCHEDULED'
       OR target_week_start IS NOT NULL OR target_week_end IS NOT NULL
       OR validation_issues <> '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'UNSUPPORTED_PREDEPLOYMENT_SCHEDULING_DATA';
  END IF;
END;
$$;

ALTER TABLE schedule_import_groups
  ALTER COLUMN student_category SET NOT NULL,
  ALTER COLUMN academic_year_start SET NOT NULL;

ALTER TABLE schedule_batches
  DROP CONSTRAINT schedule_batches_status_check,
  DROP CONSTRAINT batches_override_complete,
  ALTER COLUMN status DROP DEFAULT,
  ADD CONSTRAINT schedule_batches_status_check CHECK (status IN ('PUBLISHED', 'CANCELLED')),
  DROP COLUMN override_reason,
  DROP COLUMN overridden_by,
  DROP COLUMN overridden_at;

ALTER TABLE coordinator_schedule_items
  DROP CONSTRAINT coordinator_schedule_items_status_check,
  DROP CONSTRAINT schedule_item_target_choice,
  DROP CONSTRAINT schedule_item_week_order,
  ALTER COLUMN target_date SET NOT NULL,
  ALTER COLUMN status DROP DEFAULT,
  ADD CONSTRAINT coordinator_schedule_items_status_check CHECK (status = 'SCHEDULED'),
  DROP COLUMN target_week_start,
  DROP COLUMN target_week_end,
  DROP COLUMN validation_issues;
