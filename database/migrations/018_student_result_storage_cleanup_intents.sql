CREATE TABLE student_result_storage_cleanup_intents (
  storage_key TEXT PRIMARY KEY,
  not_before TIMESTAMPTZ NOT NULL,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  delete_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT student_result_storage_cleanup_intents_claim_check CHECK (
    (claim_token IS NULL AND claim_expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CONSTRAINT student_result_storage_cleanup_intents_attempt_count_check CHECK (
    attempt_count >= 0
  )
);

CREATE INDEX student_result_storage_cleanup_intents_due_idx
  ON student_result_storage_cleanup_intents (
    not_before,
    claim_expires_at,
    storage_key
  );
