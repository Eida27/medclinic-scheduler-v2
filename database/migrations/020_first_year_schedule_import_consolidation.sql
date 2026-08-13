ALTER TABLE schedule_import_groups
  ADD COLUMN IF NOT EXISTS import_mode VARCHAR(30) NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS first_year_laboratory_date DATE;

ALTER TABLE schedule_import_groups
  DROP CONSTRAINT IF EXISTS schedule_import_groups_import_mode_check,
  DROP CONSTRAINT IF EXISTS schedule_import_groups_category_month,
  DROP CONSTRAINT IF EXISTS schedule_import_groups_mode_metadata;

ALTER TABLE schedule_import_groups
  ADD CONSTRAINT schedule_import_groups_import_mode_check CHECK (
    import_mode IN ('STANDARD','FIRST_YEAR_OVPSA')
  ),
  ADD CONSTRAINT schedule_import_groups_mode_metadata CHECK (
    (
      import_mode='STANDARD'
      AND first_year_laboratory_date IS NULL
      AND (
        student_category IS NULL
        OR (student_category='REGULAR' AND preferred_month IS NULL)
        OR (student_category<>'REGULAR' AND preferred_month IS NOT NULL)
      )
    )
    OR
    (
      import_mode='FIRST_YEAR_OVPSA'
      AND student_category='REGULAR'
      AND preferred_month IS NULL
      AND first_year_laboratory_date IS NOT NULL
    )
  );

ALTER TABLE ovpsa_first_year_batches
  ALTER COLUMN college_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_import_group_id UUID
    REFERENCES schedule_import_groups(id);

CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_source_import_unique_idx
  ON ovpsa_first_year_batches(source_import_group_id)
  WHERE source_import_group_id IS NOT NULL;

ALTER TABLE ovpsa_first_year_batches
  DROP CONSTRAINT IF EXISTS ovpsa_first_year_batch_membership_source;
ALTER TABLE ovpsa_first_year_batches
  ADD CONSTRAINT ovpsa_first_year_batch_membership_source CHECK (
    college_id IS NOT NULL OR source_import_group_id IS NOT NULL
  );

DROP INDEX IF EXISTS ovpsa_first_year_revision_service_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_revision_service_date_idx
  ON ovpsa_first_year_service_reservations(
    revision_id,schedule_type,reservation_date
  )
  WHERE status IN ('ACTIVE','INVALIDATED');
CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_revision_laboratory_idx
  ON ovpsa_first_year_service_reservations(revision_id)
  WHERE schedule_type='LABORATORY' AND status IN ('ACTIVE','INVALIDATED');

ALTER TABLE ovpsa_first_year_membership_snapshots
  ADD COLUMN IF NOT EXISTS source_row_number INTEGER
    CHECK (source_row_number IS NULL OR source_row_number >= 2),
  ADD COLUMN IF NOT EXISTS allocation_position INTEGER
    CHECK (allocation_position IS NULL OR allocation_position > 0),
  ADD COLUMN IF NOT EXISTS assigned_pe_reservation_id UUID
    REFERENCES ovpsa_first_year_service_reservations(id);

ALTER TABLE ovpsa_first_year_membership_snapshots
  DROP CONSTRAINT IF EXISTS ovpsa_first_year_membership_import_allocation;
ALTER TABLE ovpsa_first_year_membership_snapshots
  ADD CONSTRAINT ovpsa_first_year_membership_import_allocation CHECK (
    (source_row_number IS NULL AND allocation_position IS NULL
      AND assigned_pe_reservation_id IS NULL)
    OR
    (source_row_number IS NOT NULL AND allocation_position IS NOT NULL
      AND assigned_pe_reservation_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS ovpsa_first_year_membership_source_order_idx
  ON ovpsa_first_year_membership_snapshots(revision_id,source_row_number)
  WHERE source_row_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS ovpsa_first_year_membership_pe_reservation_idx
  ON ovpsa_first_year_membership_snapshots(assigned_pe_reservation_id)
  WHERE assigned_pe_reservation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION preserve_ovpsa_first_year_batch_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_import_group_id IS DISTINCT FROM OLD.source_import_group_id THEN
    RAISE EXCEPTION 'First Year source import identity is immutable'
      USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'DRAFT'
     AND (NEW.schedule_cycle_start IS DISTINCT FROM OLD.schedule_cycle_start
       OR NEW.college_id IS DISTINCT FROM OLD.college_id) THEN
    RAISE EXCEPTION 'published OVPSA batch identity is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
