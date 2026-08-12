CREATE TABLE IF NOT EXISTS ovpsa_first_year_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_cycle_start INTEGER NOT NULL REFERENCES academic_years(start_year),
  college_id UUID NOT NULL REFERENCES colleges(id),
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','RESCHEDULE_REQUIRED','CANCELLED')),
  optimistic_token UUID NOT NULL DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ovpsa_first_year_batches_publication_complete CHECK (
    (status='DRAFT' AND published_by IS NULL AND published_at IS NULL
      AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR
    (status IN ('PUBLISHED','RESCHEDULE_REQUIRED')
      AND published_by IS NOT NULL AND published_at IS NOT NULL
      AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR
    (status='CANCELLED' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND NULLIF(BTRIM(cancellation_reason),'') IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS ovpsa_first_year_batch_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES ovpsa_first_year_batches(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','SUPERSEDED','CANCELLED')),
  laboratory_date DATE NOT NULL,
  physical_exam_date DATE NOT NULL,
  laboratory_location VARCHAR(60) NOT NULL DEFAULT 'ILOILO_MISSION_HOSPITAL'
    CHECK (laboratory_location='ILOILO_MISSION_HOSPITAL'),
  physical_exam_exception_reason TEXT,
  validation_snapshot JSONB,
  validated_by UUID REFERENCES users(id),
  validated_at TIMESTAMPTZ,
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  superseded_by_revision_id UUID REFERENCES ovpsa_first_year_batch_revisions(id),
  superseded_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ovpsa_first_year_revision_number_key UNIQUE (batch_id,revision_number),
  CONSTRAINT ovpsa_first_year_revision_date_order CHECK (
    physical_exam_date >= laboratory_date + 7
  ),
  CONSTRAINT ovpsa_first_year_revision_exception_reason CHECK (
    (physical_exam_date=laboratory_date + 7 AND physical_exam_exception_reason IS NULL)
    OR
    (physical_exam_date>laboratory_date + 7
      AND NULLIF(BTRIM(physical_exam_exception_reason),'') IS NOT NULL)
  ),
  CONSTRAINT ovpsa_first_year_revision_validation_complete CHECK (
    (status='DRAFT' AND validated_by IS NULL AND validated_at IS NULL)
    OR
    (status IN ('VALIDATED','PUBLISHED','SUPERSEDED','CANCELLED')
      AND validated_by IS NOT NULL AND validated_at IS NOT NULL
      AND validation_snapshot IS NOT NULL)
  ),
  CONSTRAINT ovpsa_first_year_revision_publication_complete CHECK (
    (status IN ('DRAFT','VALIDATED') AND published_by IS NULL AND published_at IS NULL)
    OR
    (status IN ('PUBLISHED','SUPERSEDED','CANCELLED')
      AND published_by IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_one_draft_revision_idx
  ON ovpsa_first_year_batch_revisions(batch_id)
  WHERE status='DRAFT';
CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_one_current_revision_idx
  ON ovpsa_first_year_batch_revisions(batch_id)
  WHERE status='PUBLISHED';
CREATE INDEX IF NOT EXISTS ovpsa_first_year_revisions_batch_idx
  ON ovpsa_first_year_batch_revisions(batch_id,revision_number DESC);

ALTER TABLE ovpsa_first_year_batches
  ADD COLUMN IF NOT EXISTS current_revision_id UUID
    REFERENCES ovpsa_first_year_batch_revisions(id);
CREATE INDEX IF NOT EXISTS ovpsa_first_year_batches_cycle_college_idx
  ON ovpsa_first_year_batches(schedule_cycle_start,college_id,status);
CREATE INDEX IF NOT EXISTS ovpsa_first_year_batches_current_revision_idx
  ON ovpsa_first_year_batches(current_revision_id);

CREATE TABLE IF NOT EXISTS ovpsa_first_year_membership_snapshots (
  revision_id UUID NOT NULL REFERENCES ovpsa_first_year_batch_revisions(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES ovpsa_first_year_batches(id) ON DELETE CASCADE,
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  academic_snapshot_id UUID NOT NULL REFERENCES student_academic_snapshots(id),
  student_name VARCHAR(350) NOT NULL,
  college_id UUID NOT NULL,
  college_name VARCHAR(150) NOT NULL,
  program_id UUID,
  program_code VARCHAR(30),
  program_name VARCHAR(150) NOT NULL,
  year_level INTEGER NOT NULL CHECK (year_level=1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (revision_id,student_number)
);
CREATE INDEX IF NOT EXISTS ovpsa_first_year_membership_batch_idx
  ON ovpsa_first_year_membership_snapshots(batch_id,student_number);
CREATE INDEX IF NOT EXISTS ovpsa_first_year_membership_academic_snapshot_idx
  ON ovpsa_first_year_membership_snapshots(academic_snapshot_id);

CREATE TABLE IF NOT EXISTS ovpsa_first_year_active_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES ovpsa_first_year_batches(id),
  revision_id UUID NOT NULL REFERENCES ovpsa_first_year_batch_revisions(id),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  schedule_cycle_start INTEGER NOT NULL REFERENCES academic_years(start_year),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  released_at TIMESTAMPTZ,
  released_by UUID REFERENCES users(id),
  release_reason TEXT,
  CONSTRAINT ovpsa_first_year_active_membership_release_complete CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR
    (released_at IS NOT NULL AND released_by IS NOT NULL
      AND NULLIF(BTRIM(release_reason),'') IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_active_membership_owner_idx
  ON ovpsa_first_year_active_memberships(student_number,schedule_cycle_start)
  WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_membership_revision_student_idx
  ON ovpsa_first_year_active_memberships(revision_id,student_number)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ovpsa_first_year_active_membership_batch_idx
  ON ovpsa_first_year_active_memberships(batch_id,revision_id)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS ovpsa_first_year_service_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES ovpsa_first_year_batches(id),
  revision_id UUID NOT NULL REFERENCES ovpsa_first_year_batch_revisions(id),
  schedule_type VARCHAR(30) NOT NULL
    CHECK (schedule_type IN ('LABORATORY','PHYSICAL_EXAM')),
  reservation_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','INVALIDATED','RELEASED')),
  invalidated_by_closure_group_id UUID REFERENCES clinic_closure_groups(id),
  invalidated_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  released_by UUID REFERENCES users(id),
  release_reason TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ovpsa_first_year_reservation_lifecycle CHECK (
    (status='ACTIVE' AND invalidated_by_closure_group_id IS NULL
      AND invalidated_at IS NULL AND released_at IS NULL AND released_by IS NULL
      AND release_reason IS NULL)
    OR
    (status='INVALIDATED' AND invalidated_by_closure_group_id IS NOT NULL
      AND invalidated_at IS NOT NULL AND released_at IS NULL AND released_by IS NULL
      AND release_reason IS NULL)
    OR
    (status='RELEASED' AND released_at IS NOT NULL AND released_by IS NOT NULL
      AND NULLIF(BTRIM(release_reason),'') IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_active_reservation_owner_idx
  ON ovpsa_first_year_service_reservations(schedule_type,reservation_date)
  WHERE status IN ('ACTIVE','INVALIDATED');
CREATE UNIQUE INDEX IF NOT EXISTS ovpsa_first_year_revision_service_idx
  ON ovpsa_first_year_service_reservations(revision_id,schedule_type)
  WHERE status IN ('ACTIVE','INVALIDATED');
CREATE INDEX IF NOT EXISTS ovpsa_first_year_reservations_batch_idx
  ON ovpsa_first_year_service_reservations(batch_id,revision_id,status);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS ovpsa_batch_id UUID REFERENCES ovpsa_first_year_batches(id),
  ADD COLUMN IF NOT EXISTS ovpsa_revision_id UUID REFERENCES ovpsa_first_year_batch_revisions(id),
  ADD COLUMN IF NOT EXISTS ovpsa_service_reservation_id UUID
    REFERENCES ovpsa_first_year_service_reservations(id),
  ADD COLUMN IF NOT EXISTS scheduling_category VARCHAR(30)
    CHECK (scheduling_category IN ('REGULAR','OJT','TOUR','SPECIALIZED')),
  ADD COLUMN IF NOT EXISTS scheduling_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduling_source_row_order INTEGER
    CHECK (scheduling_source_row_order IS NULL OR scheduling_source_row_order >= 0),
  ADD COLUMN IF NOT EXISTS scheduling_window_start DATE,
  ADD COLUMN IF NOT EXISTS scheduling_window_end DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='appointments_ovpsa_lineage_complete'
       AND conrelid='appointments'::regclass
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_ovpsa_lineage_complete CHECK (
        (ovpsa_batch_id IS NULL AND ovpsa_revision_id IS NULL
          AND ovpsa_service_reservation_id IS NULL)
        OR
        (ovpsa_batch_id IS NOT NULL AND ovpsa_revision_id IS NOT NULL
          AND ovpsa_service_reservation_id IS NOT NULL)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS appointments_ovpsa_batch_idx
  ON appointments(ovpsa_batch_id);
CREATE INDEX IF NOT EXISTS appointments_ovpsa_revision_idx
  ON appointments(ovpsa_revision_id);
CREATE INDEX IF NOT EXISTS appointments_ovpsa_service_reservation_idx
  ON appointments(ovpsa_service_reservation_id);
CREATE INDEX IF NOT EXISTS appointments_scheduling_lineage_idx
  ON appointments(
    scheduling_category,scheduling_accepted_at,scheduling_source_row_order
  )
  WHERE scheduling_category IS NOT NULL;

ALTER TABLE appointment_reschedule_events
  ADD COLUMN IF NOT EXISTS ovpsa_batch_id UUID REFERENCES ovpsa_first_year_batches(id),
  ADD COLUMN IF NOT EXISTS ovpsa_source_reservation_id UUID
    REFERENCES ovpsa_first_year_service_reservations(id),
  ADD COLUMN IF NOT EXISTS ovpsa_target_revision_id UUID
    REFERENCES ovpsa_first_year_batch_revisions(id),
  ADD COLUMN IF NOT EXISTS restoration_decision VARCHAR(80),
  ADD COLUMN IF NOT EXISTS restoration_details JSONB,
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restored_by UUID REFERENCES users(id);

ALTER TABLE appointment_reschedule_events
  DROP CONSTRAINT IF EXISTS appointment_reschedule_events_restoration_check;
ALTER TABLE appointment_reschedule_events
  ADD CONSTRAINT appointment_reschedule_events_restoration_check CHECK (
    restoration_decision IS NULL OR restoration_decision IN (
      'RESTORED','SKIPPED_APPOINTMENT_CHANGED','SKIPPED_PROTECTED',
      'SKIPPED_DATE_BLOCKED','SKIPPED_CAPACITY','AUTO_RESTORED',
      'MANUAL_REVIEW_REQUIRED','KEEP_CURRENT_REPLACEMENT'
    )
  );

ALTER TABLE appointment_reschedule_events
  DROP CONSTRAINT IF EXISTS appointment_reschedule_events_cause_check;
ALTER TABLE appointment_reschedule_events
  ADD CONSTRAINT appointment_reschedule_events_cause_check CHECK (
    cause IN (
      'PRIORITY_DISPLACEMENT','CLINIC_CLOSURE','MANUAL',
      'OVPSA_PUBLICATION','OVPSA_RESCHEDULE','OVPSA_CANCELLATION','OVPSA_RESTORATION'
    )
  );
CREATE INDEX IF NOT EXISTS appointment_reschedule_events_ovpsa_batch_idx
  ON appointment_reschedule_events(ovpsa_batch_id,created_at DESC);
CREATE INDEX IF NOT EXISTS appointment_reschedule_events_ovpsa_reservation_idx
  ON appointment_reschedule_events(ovpsa_source_reservation_id,student_number,created_at DESC);
CREATE INDEX IF NOT EXISTS appointment_reschedule_events_ovpsa_target_revision_idx
  ON appointment_reschedule_events(ovpsa_target_revision_id);

ALTER TABLE student_academic_snapshots
  DROP CONSTRAINT IF EXISTS student_academic_snapshots_source_type_check;
ALTER TABLE student_academic_snapshots
  ADD CONSTRAINT student_academic_snapshots_source_type_check CHECK (
    source_type IN (
      'VERIFIED_HISTORICAL','RECOVERED_HISTORICAL','MIGRATED_INCOMPLETE','OVPSA_PUBLICATION'
    )
  );

CREATE TABLE IF NOT EXISTS ovpsa_external_laboratory_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL UNIQUE REFERENCES appointments(id),
  batch_id UUID NOT NULL REFERENCES ovpsa_first_year_batches(id),
  revision_id UUID NOT NULL REFERENCES ovpsa_first_year_batch_revisions(id),
  external_provider VARCHAR(120) NOT NULL DEFAULT 'Iloilo Mission Hospital'
    CHECK (external_provider='Iloilo Mission Hospital'),
  remarks TEXT,
  verified_by UUID NOT NULL REFERENCES users(id),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS ovpsa_external_lab_batch_idx
  ON ovpsa_external_laboratory_verifications(batch_id,revision_id);
CREATE INDEX IF NOT EXISTS ovpsa_external_lab_verifier_idx
  ON ovpsa_external_laboratory_verifications(verified_by,verified_at DESC);

CREATE OR REPLACE FUNCTION preserve_ovpsa_first_year_batch_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status<>'DRAFT'
     AND (NEW.schedule_cycle_start IS DISTINCT FROM OLD.schedule_cycle_start
       OR NEW.college_id IS DISTINCT FROM OLD.college_id) THEN
    RAISE EXCEPTION 'published OVPSA batch identity is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ovpsa_first_year_batch_identity_immutable
  ON ovpsa_first_year_batches;
CREATE TRIGGER ovpsa_first_year_batch_identity_immutable
  BEFORE UPDATE ON ovpsa_first_year_batches
  FOR EACH ROW EXECUTE FUNCTION preserve_ovpsa_first_year_batch_identity();
DROP TRIGGER IF EXISTS ovpsa_first_year_batches_updated_at
  ON ovpsa_first_year_batches;
CREATE TRIGGER ovpsa_first_year_batches_updated_at
  BEFORE UPDATE ON ovpsa_first_year_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION preserve_ovpsa_first_year_revision_published_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('PUBLISHED','SUPERSEDED','CANCELLED')
     AND (NEW.batch_id IS DISTINCT FROM OLD.batch_id
       OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
       OR NEW.laboratory_date IS DISTINCT FROM OLD.laboratory_date
       OR NEW.physical_exam_date IS DISTINCT FROM OLD.physical_exam_date
       OR NEW.laboratory_location IS DISTINCT FROM OLD.laboratory_location
       OR NEW.physical_exam_exception_reason IS DISTINCT FROM OLD.physical_exam_exception_reason
       OR NEW.validation_snapshot IS DISTINCT FROM OLD.validation_snapshot
       OR NEW.validated_by IS DISTINCT FROM OLD.validated_by
       OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
       OR NEW.published_by IS DISTINCT FROM OLD.published_by
       OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'published OVPSA revision fields are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ovpsa_first_year_revision_published_fields_immutable
  ON ovpsa_first_year_batch_revisions;
CREATE TRIGGER ovpsa_first_year_revision_published_fields_immutable
  BEFORE UPDATE ON ovpsa_first_year_batch_revisions
  FOR EACH ROW EXECUTE FUNCTION preserve_ovpsa_first_year_revision_published_fields();

CREATE OR REPLACE FUNCTION reject_ovpsa_first_year_membership_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'OVPSA First Year membership snapshots are immutable'
    USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS ovpsa_first_year_membership_snapshots_immutable
  ON ovpsa_first_year_membership_snapshots;
CREATE TRIGGER ovpsa_first_year_membership_snapshots_immutable
  BEFORE UPDATE OR DELETE ON ovpsa_first_year_membership_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_ovpsa_first_year_membership_snapshot_mutation();

CREATE OR REPLACE FUNCTION preserve_ovpsa_first_year_active_membership_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.student_number IS DISTINCT FROM OLD.student_number
     OR NEW.schedule_cycle_start IS DISTINCT FROM OLD.schedule_cycle_start
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'OVPSA First Year active membership identity is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ovpsa_first_year_active_membership_identity_immutable
  ON ovpsa_first_year_active_memberships;
CREATE TRIGGER ovpsa_first_year_active_membership_identity_immutable
  BEFORE UPDATE ON ovpsa_first_year_active_memberships
  FOR EACH ROW EXECUTE FUNCTION preserve_ovpsa_first_year_active_membership_identity();

CREATE OR REPLACE FUNCTION preserve_ovpsa_first_year_reservation_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.schedule_type IS DISTINCT FROM OLD.schedule_type
     OR NEW.reservation_date IS DISTINCT FROM OLD.reservation_date
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OVPSA First Year reservation identity is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ovpsa_first_year_reservation_identity_immutable
  ON ovpsa_first_year_service_reservations;
CREATE TRIGGER ovpsa_first_year_reservation_identity_immutable
  BEFORE UPDATE ON ovpsa_first_year_service_reservations
  FOR EACH ROW EXECUTE FUNCTION preserve_ovpsa_first_year_reservation_identity();

CREATE OR REPLACE FUNCTION reject_ovpsa_external_laboratory_verification_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'external Laboratory verifications are immutable'
    USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS ovpsa_external_laboratory_verifications_immutable
  ON ovpsa_external_laboratory_verifications;
CREATE TRIGGER ovpsa_external_laboratory_verifications_immutable
  BEFORE UPDATE OR DELETE ON ovpsa_external_laboratory_verifications
  FOR EACH ROW EXECUTE FUNCTION reject_ovpsa_external_laboratory_verification_mutation();
