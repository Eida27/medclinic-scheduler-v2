BEGIN;

ALTER TABLE clinic_closure_groups
  ADD COLUMN IF NOT EXISTS recovery_mode VARCHAR(30),
  ADD COLUMN IF NOT EXISTS policy_effective_date DATE;

UPDATE clinic_closure_groups
   SET recovery_mode=COALESCE(recovery_mode,'AUTO_ELIGIBLE'),
       policy_effective_date=COALESCE(
         policy_effective_date,
         (created_at AT TIME ZONE 'Asia/Manila')::date
       )
 WHERE recovery_mode IS NULL OR policy_effective_date IS NULL;

ALTER TABLE clinic_closure_groups
  ALTER COLUMN recovery_mode SET DEFAULT 'AUTO_ELIGIBLE',
  ALTER COLUMN recovery_mode SET NOT NULL,
  ALTER COLUMN policy_effective_date SET DEFAULT
    ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date),
  ALTER COLUMN policy_effective_date SET NOT NULL;

ALTER TABLE clinic_closure_groups
  DROP CONSTRAINT IF EXISTS clinic_closure_groups_recovery_mode_check;
ALTER TABLE clinic_closure_groups
  ADD CONSTRAINT clinic_closure_groups_recovery_mode_check CHECK (
    recovery_mode IN ('AUTO_ELIGIBLE','MANUAL_ALL')
  );

CREATE OR REPLACE FUNCTION preserve_clinic_closure_group_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.creation_batch_id IS DISTINCT FROM OLD.creation_batch_id
     OR NEW.recovery_mode IS DISTINCT FROM OLD.recovery_mode
     OR NEW.policy_effective_date IS DISTINCT FROM OLD.policy_effective_date THEN
    RAISE EXCEPTION 'Clinic closure group boundaries, cause, and recovery policy are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE clinic_closure_manual_cases
  ADD COLUMN IF NOT EXISTS policy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE clinic_closure_manual_cases
  DROP CONSTRAINT IF EXISTS clinic_closure_manual_cases_reason_code_check;
ALTER TABLE clinic_closure_manual_cases
  ADD CONSTRAINT clinic_closure_manual_cases_reason_code_check CHECK (reason_code IN (
    'EMERGENCY_CLOSURE',
    'NOTICE_PERIOD_PROTECTED',
    'OVPSA_LABORATORY_PROTECTED',
    'ADMIN_CHOSE_MANUAL_RECOVERY',
    'PHYSICAL_COMPLETED_BEFORE_LABORATORY',
    'APPOINTMENT_MANUALLY_LOCKED',
    'DRAFT_RESULT_FILES_EXIST',
    'PROTECTED_RESULTS_EXIST',
    'PAIR_MISSING_OR_INCONSISTENT',
    'NO_REPLACEMENT_CAPACITY',
    'CONCURRENT_APPOINTMENT_CHANGE',
    'UNSAFE_RESTORATION'
  ));

ALTER TABLE appointment_reschedule_events
  ADD COLUMN IF NOT EXISTS policy_reason_code VARCHAR(60),
  ADD COLUMN IF NOT EXISTS policy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE appointment_reschedule_events
  DROP CONSTRAINT IF EXISTS appointment_reschedule_events_strategy_check;
ALTER TABLE appointment_reschedule_events
  ADD CONSTRAINT appointment_reschedule_events_strategy_check CHECK (
    strategy IS NULL OR strategy IN (
      'MOVE_COMPLETE_PAIR','MOVE_LABORATORY_ONLY','MOVE_PHYSICAL_ONLY',
      'MANUAL_RESOLUTION_REQUIRED'
    )
  );

ALTER TABLE appointment_reschedule_events
  DROP CONSTRAINT IF EXISTS appointment_reschedule_events_policy_reason_check;
ALTER TABLE appointment_reschedule_events
  ADD CONSTRAINT appointment_reschedule_events_policy_reason_check CHECK (
    policy_reason_code IS NULL OR policy_reason_code IN (
      'EMERGENCY_CLOSURE',
      'NOTICE_PERIOD_PROTECTED',
      'OVPSA_LABORATORY_PROTECTED',
      'ADMIN_CHOSE_MANUAL_RECOVERY',
      'PHYSICAL_COMPLETED_BEFORE_LABORATORY',
      'APPOINTMENT_MANUALLY_LOCKED',
      'DRAFT_RESULT_FILES_EXIST',
      'PROTECTED_RESULTS_EXIST',
      'PAIR_MISSING_OR_INCONSISTENT',
      'NO_REPLACEMENT_CAPACITY',
      'CONCURRENT_APPOINTMENT_CHANGE',
      'UNSAFE_RESTORATION'
    )
  );

ALTER TABLE ovpsa_first_year_service_reservations
  ADD COLUMN IF NOT EXISTS reservation_kind VARCHAR(30)
    NOT NULL DEFAULT 'EXCLUSIVE';

ALTER TABLE ovpsa_first_year_service_reservations
  DROP CONSTRAINT IF EXISTS ovpsa_first_year_service_reservations_reservation_kind_check;
ALTER TABLE ovpsa_first_year_service_reservations
  ADD CONSTRAINT ovpsa_first_year_service_reservations_reservation_kind_check CHECK (
    reservation_kind IN ('EXCLUSIVE','CLOSURE_RECOVERY')
  );

DROP INDEX IF EXISTS ovpsa_first_year_active_reservation_owner_idx;
CREATE UNIQUE INDEX ovpsa_first_year_active_reservation_owner_idx
  ON ovpsa_first_year_service_reservations(schedule_type,reservation_date)
  WHERE status IN ('ACTIVE','INVALIDATED') AND reservation_kind='EXCLUSIVE';

DROP INDEX IF EXISTS ovpsa_first_year_revision_service_date_idx;
DROP INDEX IF EXISTS ovpsa_first_year_revision_service_idx;
CREATE UNIQUE INDEX ovpsa_first_year_revision_service_date_idx
  ON ovpsa_first_year_service_reservations(
    revision_id,schedule_type,reservation_date
  )
  WHERE status IN ('ACTIVE','INVALIDATED') AND reservation_kind='EXCLUSIVE';

DROP INDEX IF EXISTS ovpsa_first_year_revision_laboratory_idx;
CREATE UNIQUE INDEX ovpsa_first_year_revision_laboratory_idx
  ON ovpsa_first_year_service_reservations(revision_id)
  WHERE schedule_type='LABORATORY'
    AND status IN ('ACTIVE','INVALIDATED')
    AND reservation_kind='EXCLUSIVE';

CREATE OR REPLACE FUNCTION preserve_ovpsa_first_year_reservation_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.schedule_type IS DISTINCT FROM OLD.schedule_type
     OR NEW.reservation_date IS DISTINCT FROM OLD.reservation_date
     OR NEW.reservation_kind IS DISTINCT FROM OLD.reservation_kind
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OVPSA First Year reservation identity is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
