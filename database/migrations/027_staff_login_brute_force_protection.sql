CREATE TABLE staff_login_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(10) NOT NULL
    CHECK (scope IN ('EMAIL', 'IP')),
  bucket_key VARCHAR(320) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX staff_login_failures_bucket_time_idx
  ON staff_login_failures (scope, bucket_key, occurred_at DESC);

CREATE INDEX staff_login_failures_occurred_at_idx
  ON staff_login_failures (occurred_at);
