BEGIN;

CREATE INDEX IF NOT EXISTS appointments_current_service_lookup_idx
  ON appointments (
    student_number,
    schedule_type,
    appointment_date DESC,
    created_at DESC,
    id DESC
  )
  WHERE is_published = TRUE AND status <> 'DRAFT';

CREATE INDEX IF NOT EXISTS student_result_submissions_admin_profile_idx
  ON student_result_submissions (
    student_number,
    appointment_id,
    last_activity_at DESC,
    created_at DESC,
    id DESC
  )
  WHERE status IN ('FINALIZED', 'INVALIDATED');

COMMIT;
