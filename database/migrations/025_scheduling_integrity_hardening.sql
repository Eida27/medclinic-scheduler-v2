BEGIN;

ALTER TABLE clinic_closure_manual_cases
  ADD COLUMN IF NOT EXISTS case_source VARCHAR(40);

UPDATE clinic_closure_manual_cases
   SET case_source='CLINIC_CLOSURE'
 WHERE case_source IS NULL;

ALTER TABLE clinic_closure_manual_cases
  ALTER COLUMN case_source SET DEFAULT 'CLINIC_CLOSURE',
  ALTER COLUMN case_source SET NOT NULL,
  ALTER COLUMN closure_group_id DROP NOT NULL;

ALTER TABLE clinic_closure_manual_cases
  DROP CONSTRAINT IF EXISTS clinic_closure_manual_cases_case_source_check;
ALTER TABLE clinic_closure_manual_cases
  ADD CONSTRAINT clinic_closure_manual_cases_case_source_check CHECK (
    case_source IN ('CLINIC_CLOSURE','AUTOMATIC_DISPLACEMENT')
  );

ALTER TABLE clinic_closure_manual_cases
  DROP CONSTRAINT IF EXISTS clinic_closure_manual_cases_closure_source_check;
ALTER TABLE clinic_closure_manual_cases
  ADD CONSTRAINT clinic_closure_manual_cases_closure_source_check CHECK (
    closure_group_id IS NOT NULL OR case_source='AUTOMATIC_DISPLACEMENT'
  );

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
    'NO_VALID_REPLACEMENT_WITHIN_CYCLE',
    'CONCURRENT_APPOINTMENT_CHANGE',
    'UNSAFE_RESTORATION'
  ));

ALTER TABLE clinic_closure_manual_cases
  DROP CONSTRAINT IF EXISTS clinic_closure_manual_cases_resolution_action_check;
ALTER TABLE clinic_closure_manual_cases
  ADD CONSTRAINT clinic_closure_manual_cases_resolution_action_check CHECK (
    resolution_action IS NULL OR resolution_action IN (
      'ASSIGN_REPLACEMENT','KEEP_CURRENT_REPLACEMENT','RESTORE_ORIGINAL'
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
      'NO_VALID_REPLACEMENT_WITHIN_CYCLE',
      'CONCURRENT_APPOINTMENT_CHANGE',
      'UNSAFE_RESTORATION'
    )
  );

COMMIT;
