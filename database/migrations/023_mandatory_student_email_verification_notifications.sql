CREATE UNIQUE INDEX IF NOT EXISTS students_active_verified_email_unique_idx
  ON students (LOWER(BTRIM(email)))
  WHERE email_verified_at IS NOT NULL AND is_active = TRUE;

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS message_kind VARCHAR(30) NOT NULL DEFAULT 'SCHEDULE',
  ADD COLUMN IF NOT EXISTS notification_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS portal_notification_id UUID
    REFERENCES student_portal_notifications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS schedule_fingerprint CHAR(64),
  ADD COLUMN IF NOT EXISTS verification_body_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_attempt_status VARCHAR(30);

ALTER TABLE email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_status_check,
  DROP CONSTRAINT IF EXISTS email_outbox_message_kind_check,
  DROP CONSTRAINT IF EXISTS email_outbox_schedule_fingerprint_check,
  DROP CONSTRAINT IF EXISTS email_outbox_last_attempt_status_check,
  DROP CONSTRAINT IF EXISTS email_outbox_verification_body_check;

ALTER TABLE email_outbox
  ADD CONSTRAINT email_outbox_status_check
    CHECK (status IN ('PENDING','PROCESSING','SENT','PERMANENT_FAILURE','OBSOLETE')),
  ADD CONSTRAINT email_outbox_message_kind_check
    CHECK (message_kind IN ('SCHEDULE','VERIFICATION')),
  ADD CONSTRAINT email_outbox_schedule_fingerprint_check
    CHECK (schedule_fingerprint IS NULL OR schedule_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT email_outbox_last_attempt_status_check
    CHECK (
      last_attempt_status IS NULL
      OR last_attempt_status IN ('PENDING','SENT','PERMANENT_FAILURE','OBSOLETE')
    ),
  ADD CONSTRAINT email_outbox_verification_body_check
    CHECK (
      (message_kind='SCHEDULE' AND verification_body_encrypted IS NULL)
      OR (
        message_kind='VERIFICATION'
        AND subject='Verify your MedClinic notification email'
        AND text_body='Verification email content is encrypted.'
        AND html_body IS NULL
        AND (
          verification_body_encrypted IS NOT NULL
          OR status IN ('SENT','OBSOLETE')
        )
      )
    );

CREATE INDEX IF NOT EXISTS email_outbox_portal_notification_idx
  ON email_outbox (portal_notification_id)
  WHERE portal_notification_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_outbox_schedule_fingerprint_idx
  ON email_outbox (student_number,schedule_fingerprint)
  WHERE message_kind='SCHEDULE' AND schedule_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS email_outbox_actionable_failure_idx
  ON email_outbox (created_at DESC,id)
  WHERE status='PERMANENT_FAILURE';
