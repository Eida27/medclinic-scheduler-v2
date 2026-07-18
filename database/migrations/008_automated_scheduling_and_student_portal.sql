ALTER TABLE students
  ADD COLUMN date_of_birth DATE,
  ADD COLUMN email VARCHAR(254),
  ADD COLUMN email_verified_at TIMESTAMPTZ,
  ADD CONSTRAINT students_birth_date_reasonable
    CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1900-01-01'),
  ADD CONSTRAINT students_verified_email_complete
    CHECK (email_verified_at IS NULL OR NULLIF(BTRIM(email), '') IS NOT NULL);

ALTER TABLE schedule_import_groups
  ADD COLUMN student_category VARCHAR(30)
    CHECK (student_category IN ('REGULAR', 'OJT', 'TOUR', 'SPECIALIZED')),
  ADD COLUMN academic_year_start INTEGER
    CHECK (academic_year_start BETWEEN 2020 AND 2100),
  ADD COLUMN preferred_month INTEGER
    CHECK (preferred_month BETWEEN 1 AND 12),
  ADD COLUMN accepted_at TIMESTAMPTZ;

UPDATE schedule_import_groups
   SET accepted_at = created_at
 WHERE accepted_at IS NULL;

ALTER TABLE schedule_import_groups
  ALTER COLUMN accepted_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN accepted_at SET NOT NULL,
  ADD CONSTRAINT schedule_import_groups_category_month
    CHECK (
      student_category IS NULL
      OR (student_category = 'REGULAR' AND preferred_month IS NULL)
      OR (student_category <> 'REGULAR' AND preferred_month IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION preserve_schedule_import_accepted_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'schedule import accepted_at is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER schedule_import_groups_accepted_at_immutable
  BEFORE UPDATE OF accepted_at ON schedule_import_groups
  FOR EACH ROW EXECUTE FUNCTION preserve_schedule_import_accepted_at();

ALTER TABLE coordinator_schedule_items
  ALTER COLUMN priority_group_id DROP NOT NULL,
  ADD COLUMN source_row_order INTEGER CHECK (source_row_order > 0),
  ADD COLUMN schedule_cycle_start INTEGER
    CHECK (schedule_cycle_start BETWEEN 2020 AND 2100);

ALTER TABLE appointments
  ADD COLUMN schedule_pair_id UUID,
  ADD COLUMN schedule_cycle_start INTEGER,
  ADD COLUMN is_manually_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN locked_by UUID REFERENCES users(id),
  ADD COLUMN locked_at TIMESTAMPTZ,
  ADD COLUMN lock_reason TEXT;

UPDATE appointments
   SET schedule_cycle_start = CASE
     WHEN EXTRACT(MONTH FROM appointment_date) >= 8
       THEN EXTRACT(YEAR FROM appointment_date)::INTEGER
     ELSE EXTRACT(YEAR FROM appointment_date)::INTEGER - 1
   END
 WHERE schedule_cycle_start IS NULL;

ALTER TABLE appointments
  ALTER COLUMN schedule_cycle_start SET NOT NULL,
  ADD CONSTRAINT appointments_schedule_cycle_reasonable
    CHECK (schedule_cycle_start BETWEEN 2020 AND 2100),
  ADD CONSTRAINT appointments_manual_lock_complete
    CHECK (
      (is_manually_locked = FALSE AND locked_by IS NULL AND locked_at IS NULL AND lock_reason IS NULL)
      OR
      (is_manually_locked = TRUE AND locked_by IS NOT NULL AND locked_at IS NOT NULL
       AND NULLIF(BTRIM(lock_reason), '') IS NOT NULL)
    );

DROP INDEX appointments_one_active_service_idx;

CREATE UNIQUE INDEX appointments_one_active_service_cycle_idx
  ON appointments (student_number, clinic_id, schedule_type, schedule_cycle_start)
  WHERE status IN ('DRAFT', 'PENDING');

CREATE INDEX appointments_schedule_pair_idx
  ON appointments (schedule_pair_id, schedule_cycle_start);

CREATE TABLE clinic_unavailable_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  category VARCHAR(40) NOT NULL
    CHECK (category IN ('HOLIDAY', 'CLOSURE', 'MAINTENANCE', 'STAFF_UNAVAILABILITY')),
  reason TEXT NOT NULL CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX clinic_unavailable_dates_lookup_idx
  ON clinic_unavailable_dates (clinic_id, start_date, end_date);

CREATE TRIGGER clinic_unavailable_dates_updated_at
  BEFORE UPDATE ON clinic_unavailable_dates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE appointment_reschedule_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  schedule_pair_id UUID,
  cause VARCHAR(40) NOT NULL
    CHECK (cause IN ('PRIORITY_DISPLACEMENT', 'CLINIC_CLOSURE', 'MANUAL')),
  source_import_group_id UUID REFERENCES schedule_import_groups(id),
  clinic_unavailable_date_id UUID REFERENCES clinic_unavailable_dates(id),
  old_laboratory_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  new_laboratory_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  old_physical_exam_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  new_physical_exam_appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    old_laboratory_appointment_id IS NOT NULL
    OR old_physical_exam_appointment_id IS NOT NULL
  )
);

CREATE INDEX appointment_reschedule_events_student_idx
  ON appointment_reschedule_events (student_number, created_at DESC);

CREATE TABLE student_login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL,
  ip_address VARCHAR(64) NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  first_failed_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_number, ip_address)
);

CREATE TRIGGER student_login_attempts_updated_at
  BEFORE UPDATE ON student_login_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE student_email_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number) ON DELETE CASCADE,
  pending_email VARCHAR(254) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX student_email_verifications_student_idx
  ON student_email_verifications (student_number, created_at DESC);

CREATE TABLE student_portal_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,
  title VARCHAR(180) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX student_portal_notifications_student_idx
  ON student_portal_notifications (student_number, read_at, created_at DESC);

CREATE TABLE email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) REFERENCES students(student_number) ON DELETE SET NULL,
  to_email VARCHAR(254) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'PERMANENT_FAILURE')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX email_outbox_claim_idx
  ON email_outbox (status, next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'PROCESSING');

CREATE TRIGGER email_outbox_updated_at
  BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE exam_results
  DROP CONSTRAINT IF EXISTS exam_results_result_status_check;

ALTER TABLE laboratory_results
  DROP CONSTRAINT IF EXISTS laboratory_results_result_status_check;

UPDATE exam_results SET result_status = 'PENDING_UPLOAD' WHERE result_status = 'PENDING';
UPDATE laboratory_results SET result_status = 'PENDING_UPLOAD' WHERE result_status = 'PENDING';

ALTER TABLE exam_results
  ADD CONSTRAINT exam_results_result_status_check
    CHECK (result_status IN ('PENDING_UPLOAD', 'COMPLETED', 'REQUIRES_FOLLOW_UP', 'NOT_APPLICABLE'));

ALTER TABLE laboratory_results
  ADD CONSTRAINT laboratory_results_result_status_check
    CHECK (result_status IN ('PENDING_UPLOAD', 'COMPLETED', 'REQUIRES_FOLLOW_UP', 'NOT_APPLICABLE'));

CREATE TABLE student_result_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number) ON DELETE CASCADE,
  result_type VARCHAR(30) NOT NULL CHECK (result_type IN ('PHYSICAL_EXAM', 'LABORATORY')),
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'FINALIZED', 'INVALIDATED')),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  invalidated_by UUID REFERENCES users(id),
  invalidation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'DRAFT' AND finalized_at IS NULL AND invalidated_at IS NULL
      AND invalidated_by IS NULL AND invalidation_reason IS NULL)
    OR
    (status = 'FINALIZED' AND finalized_at IS NOT NULL AND invalidated_at IS NULL
      AND invalidated_by IS NULL AND invalidation_reason IS NULL)
    OR
    (status = 'INVALIDATED' AND finalized_at IS NOT NULL AND invalidated_at IS NOT NULL
      AND invalidated_by IS NOT NULL AND NULLIF(BTRIM(invalidation_reason), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX student_result_submissions_one_draft_idx
  ON student_result_submissions (appointment_id)
  WHERE status = 'DRAFT';

CREATE UNIQUE INDEX student_result_submissions_one_finalized_idx
  ON student_result_submissions (appointment_id)
  WHERE status = 'FINALIZED';

CREATE INDEX student_result_submissions_student_idx
  ON student_result_submissions (student_number, created_at DESC);

CREATE TRIGGER student_result_submissions_updated_at
  BEFORE UPDATE ON student_result_submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE student_result_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES student_result_submissions(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  original_filename VARCHAR(255) NOT NULL,
  detected_mime_type VARCHAR(100) NOT NULL,
  extension VARCHAR(10) NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  checksum_sha256 CHAR(64) NOT NULL,
  storage_delete_pending BOOLEAN NOT NULL DEFAULT FALSE,
  delete_error TEXT,
  deleted_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX student_result_files_submission_idx
  ON student_result_files (submission_id, uploaded_at);
