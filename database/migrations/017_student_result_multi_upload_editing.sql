ALTER TABLE student_result_submissions
  ADD COLUMN based_on_submission_id UUID REFERENCES student_result_submissions(id),
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD COLUMN superseded_by_submission_id UUID REFERENCES student_result_submissions(id),
  ADD COLUMN discarded_at TIMESTAMPTZ;

ALTER TABLE student_result_submissions
  DROP CONSTRAINT IF EXISTS student_result_submissions_status_check,
  DROP CONSTRAINT IF EXISTS student_result_submissions_check;

ALTER TABLE student_result_submissions
  ADD CONSTRAINT student_result_submissions_status_check CHECK (
    status IN ('DRAFT', 'FINALIZED', 'INVALIDATED', 'SUPERSEDED')
  ),
  ADD CONSTRAINT student_result_submissions_lifecycle_check CHECK (
    (
      status = 'DRAFT'
      AND finalized_at IS NULL
      AND invalidated_at IS NULL
      AND invalidated_by IS NULL
      AND invalidation_reason IS NULL
      AND superseded_at IS NULL
      AND superseded_by_submission_id IS NULL
    )
    OR
    (
      status = 'FINALIZED'
      AND finalized_at IS NOT NULL
      AND invalidated_at IS NULL
      AND invalidated_by IS NULL
      AND invalidation_reason IS NULL
      AND based_on_submission_id IS NULL
      AND superseded_at IS NULL
      AND superseded_by_submission_id IS NULL
      AND discarded_at IS NULL
    )
    OR
    (
      status = 'INVALIDATED'
      AND finalized_at IS NOT NULL
      AND invalidated_at IS NOT NULL
      AND invalidated_by IS NOT NULL
      AND NULLIF(BTRIM(invalidation_reason), '') IS NOT NULL
      AND based_on_submission_id IS NULL
      AND superseded_at IS NULL
      AND superseded_by_submission_id IS NULL
      AND discarded_at IS NULL
    )
    OR
    (
      status = 'SUPERSEDED'
      AND finalized_at IS NOT NULL
      AND invalidated_at IS NULL
      AND invalidated_by IS NULL
      AND invalidation_reason IS NULL
      AND based_on_submission_id IS NULL
      AND superseded_at IS NOT NULL
      AND superseded_by_submission_id IS NOT NULL
      AND discarded_at IS NULL
    )
  ),
  ADD CONSTRAINT student_result_submissions_no_self_reference_check CHECK (
    based_on_submission_id IS DISTINCT FROM id
    AND superseded_by_submission_id IS DISTINCT FROM id
  );

DROP INDEX IF EXISTS student_result_submissions_one_draft_idx;

CREATE UNIQUE INDEX student_result_submissions_one_draft_idx
  ON student_result_submissions (appointment_id)
  WHERE status = 'DRAFT' AND discarded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS student_result_submissions_one_finalized_idx
  ON student_result_submissions (appointment_id)
  WHERE status = 'FINALIZED';

CREATE INDEX student_result_submissions_based_on_idx
  ON student_result_submissions (based_on_submission_id);

CREATE INDEX student_result_submissions_superseded_by_idx
  ON student_result_submissions (superseded_by_submission_id);

DROP INDEX IF EXISTS student_result_submissions_admin_profile_idx;

CREATE INDEX student_result_submissions_admin_profile_idx
  ON student_result_submissions (
    student_number,
    appointment_id,
    last_activity_at DESC,
    created_at DESC,
    id DESC
  )
  WHERE status IN ('FINALIZED', 'INVALIDATED', 'SUPERSEDED');
