ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS credential_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id);

ALTER TABLE users
  ALTER COLUMN email TYPE VARCHAR(254),
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_email_normalized,
  DROP CONSTRAINT IF EXISTS users_credential_version_check,
  DROP CONSTRAINT IF EXISTS users_account_lifecycle_check;

ALTER TABLE users
  ADD CONSTRAINT users_email_normalized
    CHECK (email IS NULL OR email = LOWER(BTRIM(email))),
  ADD CONSTRAINT users_credential_version_check
    CHECK (credential_version > 0),
  ADD CONSTRAINT users_account_lifecycle_check
    CHECK (
      (
        deleted_at IS NULL
        AND deleted_by IS NULL
        AND email IS NOT NULL
        AND password_hash IS NOT NULL
      )
      OR
      (
        deleted_at IS NOT NULL
        AND deleted_by IS NOT NULL
        AND email IS NULL
        AND password_hash IS NULL
        AND email_verified_at IS NULL
        AND must_change_password = FALSE
      )
    );

DROP INDEX IF EXISTS users_email_unique;
DROP INDEX IF EXISTS users_active_email_unique_idx;
CREATE UNIQUE INDEX users_active_email_unique_idx
  ON users (LOWER(BTRIM(email)))
  WHERE deleted_at IS NULL;

ALTER TABLE users DROP COLUMN IF EXISTS is_active;

CREATE TABLE IF NOT EXISTS staff_email_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  pending_email VARCHAR(254) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_email_verifications_email_normalized
    CHECK (pending_email = LOWER(BTRIM(pending_email))),
  CONSTRAINT staff_email_verifications_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT staff_email_verifications_lifecycle_check
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

CREATE INDEX IF NOT EXISTS staff_email_verifications_user_idx
  ON staff_email_verifications (user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS staff_email_verifications_request_throttle_idx
  ON staff_email_verifications (user_id,created_at DESC)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS staff_password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_password_resets_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT staff_password_resets_lifecycle_check
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

CREATE INDEX IF NOT EXISTS staff_password_resets_user_idx
  ON staff_password_resets (user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS staff_password_resets_request_throttle_idx
  ON staff_password_resets (user_id,created_at DESC)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

ALTER TABLE email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_message_kind_check,
  DROP CONSTRAINT IF EXISTS email_outbox_verification_body_check;

ALTER TABLE email_outbox
  ADD CONSTRAINT email_outbox_message_kind_check
    CHECK (message_kind IN ('GENERAL','SCHEDULE','VERIFICATION','STAFF_SECURITY')),
  ADD CONSTRAINT email_outbox_verification_body_check
    CHECK (
      (message_kind IN ('GENERAL','SCHEDULE') AND verification_body_encrypted IS NULL)
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
      OR (
        message_kind='STAFF_SECURITY'
        AND student_number IS NULL
        AND source_type IN ('STAFF_EMAIL_VERIFICATION','STAFF_PASSWORD_RESET')
        AND NULLIF(BTRIM(source_id),'') IS NOT NULL
        AND text_body='Staff security email content is encrypted.'
        AND html_body IS NULL
        AND (
          verification_body_encrypted IS NOT NULL
          OR status IN ('SENT','OBSOLETE')
        )
      )
    );

CREATE INDEX IF NOT EXISTS email_outbox_staff_security_source_idx
  ON email_outbox (source_type,source_id,created_at DESC)
  WHERE message_kind='STAFF_SECURITY';
