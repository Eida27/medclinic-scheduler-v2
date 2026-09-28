ALTER TABLE clinical_mutation_requests DROP CONSTRAINT clinical_mutation_requests_action_check;
ALTER TABLE clinical_mutation_requests ADD CONSTRAINT clinical_mutation_requests_action_check
  CHECK (action IN ('ISSUE_CERTIFICATE','CORRECT_CERTIFICATE','REVOKE_CERTIFICATE','BULK_REPLACEMENT','BULK_MANUAL_RESOLUTION'));
