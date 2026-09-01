ALTER TABLE clinic_closure_manual_cases
  DROP CONSTRAINT clinic_closure_manual_cases_reason_code_check,
  ADD CONSTRAINT clinic_closure_manual_cases_reason_code_check CHECK (reason_code IN (
    'PHYSICAL_COMPLETED_BEFORE_LABORATORY',
    'APPOINTMENT_MANUALLY_LOCKED',
    'DRAFT_RESULT_FILES_EXIST',
    'PROTECTED_RESULTS_EXIST',
    'PAIR_MISSING_OR_INCONSISTENT',
    'NO_REPLACEMENT_CAPACITY',
    'CONCURRENT_APPOINTMENT_CHANGE',
    'UNSAFE_RESTORATION'
  ));
