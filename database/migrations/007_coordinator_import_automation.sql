ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('ADMIN', 'COORDINATOR', 'CLINIC_STAFF'));

ALTER TABLE users
  ADD CONSTRAINT users_coordinator_global
  CHECK (role <> 'COORDINATOR' OR clinic_id IS NULL);
