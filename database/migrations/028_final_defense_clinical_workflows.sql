-- Fresh-install migration: existing clinical facts cannot be inferred or backfilled.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM appointments)
     OR EXISTS (SELECT 1 FROM laboratory_results)
     OR EXISTS (SELECT 1 FROM exam_results)
     OR EXISTS (SELECT 1 FROM student_result_submissions)
     OR EXISTS (SELECT 1 FROM ovpsa_external_laboratory_verifications) THEN
    RAISE EXCEPTION 'unsupported-preexisting-clinical-data: migration 028 requires a fresh clinical database'
      USING ERRCODE='23514';
  END IF;
END $$;

ALTER TABLE clinic_closure_manual_cases
  DROP CONSTRAINT clinic_closure_manual_cases_reason_code_check;
ALTER TABLE clinic_closure_manual_cases
  ADD CONSTRAINT clinic_closure_manual_cases_reason_code_check CHECK (reason_code IN (
    'EMERGENCY_CLOSURE','NOTICE_PERIOD_PROTECTED','OVPSA_LABORATORY_PROTECTED',
    'ADMIN_CHOSE_MANUAL_RECOVERY','PHYSICAL_COMPLETED_BEFORE_LABORATORY',
    'APPOINTMENT_MANUALLY_LOCKED','DRAFT_RESULT_FILES_EXIST',
    'LABORATORY_PROGRESS_RECORDED','PROTECTED_RESULTS_EXIST',
    'PAIR_MISSING_OR_INCONSISTENT','NO_REPLACEMENT_CAPACITY',
    'NO_VALID_REPLACEMENT_WITHIN_CYCLE','CONCURRENT_APPOINTMENT_CHANGE',
    'UNSAFE_RESTORATION'
  ));
ALTER TABLE appointment_reschedule_events
  DROP CONSTRAINT appointment_reschedule_events_policy_reason_check;
ALTER TABLE appointment_reschedule_events
  ADD CONSTRAINT appointment_reschedule_events_policy_reason_check CHECK (
    policy_reason_code IS NULL OR policy_reason_code IN (
      'EMERGENCY_CLOSURE','NOTICE_PERIOD_PROTECTED','OVPSA_LABORATORY_PROTECTED',
      'ADMIN_CHOSE_MANUAL_RECOVERY','PHYSICAL_COMPLETED_BEFORE_LABORATORY',
      'APPOINTMENT_MANUALLY_LOCKED','DRAFT_RESULT_FILES_EXIST',
      'LABORATORY_PROGRESS_RECORDED','PROTECTED_RESULTS_EXIST',
      'PAIR_MISSING_OR_INCONSISTENT','NO_REPLACEMENT_CAPACITY',
      'NO_VALID_REPLACEMENT_WITHIN_CYCLE','CONCURRENT_APPOINTMENT_CHANGE',
      'UNSAFE_RESTORATION'
    )
  );

ALTER TABLE student_result_submissions DROP CONSTRAINT student_result_submissions_result_type_check;
ALTER TABLE student_result_submissions ADD CONSTRAINT student_result_submissions_result_type_check
  CHECK (result_type='LABORATORY');
ALTER TABLE exam_results DROP CONSTRAINT exam_results_result_status_check;
ALTER TABLE exam_results ALTER COLUMN result_status DROP DEFAULT;
ALTER TABLE exam_results ADD CONSTRAINT exam_results_result_status_check
  CHECK (result_status IN ('COMPLETED','REQUIRES_FOLLOW_UP'));

CREATE TABLE laboratory_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_appointment_id UUID NOT NULL UNIQUE REFERENCES appointments(id),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  academic_year_start INTEGER NOT NULL REFERENCES academic_years(start_year),
  academic_snapshot_id UUID NOT NULL REFERENCES student_academic_snapshots(id),
  year_level_snapshot INTEGER NOT NULL CHECK (year_level_snapshot BETWEEN 1 AND 4),
  scheduling_category_snapshot VARCHAR(30) NOT NULL CHECK (scheduling_category_snapshot IN ('REGULAR','OJT','TOUR')),
  requirements_version INTEGER NOT NULL DEFAULT 1 CHECK (requirements_version=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX laboratory_checklists_student_year_idx ON laboratory_checklists(student_number,academic_year_start);
CREATE INDEX laboratory_checklists_snapshot_idx ON laboratory_checklists(academic_snapshot_id);

CREATE TABLE laboratory_checklist_items (
  checklist_id UUID NOT NULL REFERENCES laboratory_checklists(id),
  test_code VARCHAR(10) NOT NULL CHECK (test_code IN ('CBC','URINE','STOOL','XRAY')),
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES users(id),
  verification_source VARCHAR(10) CHECK (verification_source IN ('INTERNAL','EXTERNAL')),
  PRIMARY KEY (checklist_id,test_code),
  CHECK ((verified_at IS NULL AND verified_by IS NULL AND verification_source IS NULL)
    OR (verified_at IS NOT NULL AND verified_by IS NOT NULL AND verification_source IS NOT NULL))
);
CREATE INDEX laboratory_checklist_items_verified_idx ON laboratory_checklist_items(checklist_id) WHERE verified_at IS NOT NULL;

CREATE TABLE laboratory_checklist_appointments (
  appointment_id UUID PRIMARY KEY REFERENCES appointments(id),
  checklist_id UUID NOT NULL REFERENCES laboratory_checklists(id),
  UNIQUE (appointment_id,checklist_id)
);
CREATE INDEX laboratory_checklist_appointments_checklist_idx ON laboratory_checklist_appointments(checklist_id);

CREATE TABLE laboratory_checklist_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID NOT NULL,
  appointment_id UUID NOT NULL,
  test_code VARCHAR(10) NOT NULL,
  old_verified BOOLEAN NOT NULL,
  new_verified BOOLEAN NOT NULL,
  source VARCHAR(10) NOT NULL CHECK (source IN ('INTERNAL','EXTERNAL')),
  reason TEXT,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  actor_snapshot JSONB NOT NULL CHECK (jsonb_typeof(actor_snapshot)='object' AND actor_snapshot<>'{}'::jsonb),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (checklist_id,test_code) REFERENCES laboratory_checklist_items(checklist_id,test_code),
  FOREIGN KEY (appointment_id,checklist_id) REFERENCES laboratory_checklist_appointments(appointment_id,checklist_id),
  CHECK (old_verified<>new_verified),
  CHECK (new_verified OR NULLIF(BTRIM(reason),'') IS NOT NULL)
);
CREATE INDEX laboratory_checklist_events_checklist_idx ON laboratory_checklist_events(checklist_id,created_at);

CREATE TABLE medical_certificate_physicians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE medical_certificate_physician_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  physician_id UUID NOT NULL REFERENCES medical_certificate_physicians(id),
  version INTEGER NOT NULL CHECK (version>0),
  display_name VARCHAR(200) NOT NULL CHECK (NULLIF(BTRIM(display_name),'') IS NOT NULL AND display_name !~ '[[:cntrl:]]'),
  license_number VARCHAR(60) NOT NULL CHECK (NULLIF(BTRIM(license_number),'') IS NOT NULL AND license_number !~ '[[:cntrl:]]'),
  specialty VARCHAR(120) CHECK (specialty !~ '[[:cntrl:]]'),
  signature_bytes BYTEA NOT NULL CHECK (octet_length(signature_bytes) BETWEEN 1 AND 8388608),
  signature_media_type VARCHAR(20) NOT NULL CHECK (signature_media_type IN ('image/png','image/jpeg')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  actor_snapshot JSONB NOT NULL CHECK (jsonb_typeof(actor_snapshot)='object' AND actor_snapshot<>'{}'::jsonb),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (physician_id,version)
);

CREATE TABLE medical_certificate_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id UUID NOT NULL,
  appointment_id UUID NOT NULL REFERENCES appointments(id),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  academic_year_start INTEGER NOT NULL REFERENCES academic_years(start_year),
  revision_number INTEGER NOT NULL CHECK (revision_number>0),
  supersedes_revision_id UUID UNIQUE REFERENCES medical_certificate_revisions(id),
  status VARCHAR(20) NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','SUPERSEDED','REVOKED')),
  physician_revision_id UUID NOT NULL REFERENCES medical_certificate_physician_revisions(id),
  student_snapshot JSONB NOT NULL CHECK (jsonb_typeof(student_snapshot)='object' AND student_snapshot<>'{}'::jsonb),
  examination_snapshot JSONB NOT NULL CHECK (jsonb_typeof(examination_snapshot)='object' AND examination_snapshot<>'{}'::jsonb),
  physician_snapshot JSONB NOT NULL CHECK (jsonb_typeof(physician_snapshot)='object' AND physician_snapshot<>'{}'::jsonb),
  classification CHAR(1) NOT NULL CHECK (classification IN ('A','B','C','D')),
  remarks VARCHAR(1000) CHECK (replace(remarks,E'\n','') !~ '[[:cntrl:]]'),
  examination_date DATE NOT NULL,
  sex VARCHAR(30) NOT NULL CHECK (NULLIF(BTRIM(sex),'') IS NOT NULL AND sex !~ '[[:cntrl:]]'),
  template_version VARCHAR(60) NOT NULL CHECK (NULLIF(BTRIM(template_version),'') IS NOT NULL),
  jpeg_bytes BYTEA NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 8388608),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  issued_by UUID NOT NULL REFERENCES users(id),
  issued_by_snapshot JSONB NOT NULL CHECK (jsonb_typeof(issued_by_snapshot)='object' AND issued_by_snapshot<>'{}'::jsonb),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id UUID NOT NULL,
  UNIQUE (certificate_id,revision_number),
  CHECK (classification='A' OR NULLIF(BTRIM(remarks),'') IS NOT NULL),
  CHECK (byte_length=octet_length(jpeg_bytes) AND sha256=encode(digest(jpeg_bytes,'sha256'),'hex')),
  CHECK ((revision_number=1 AND supersedes_revision_id IS NULL) OR (revision_number>1 AND supersedes_revision_id IS NOT NULL))
);
CREATE UNIQUE INDEX medical_certificate_one_issued_idx ON medical_certificate_revisions(appointment_id) WHERE status='ISSUED';
CREATE INDEX medical_certificate_student_year_idx ON medical_certificate_revisions(student_number,academic_year_start);
CREATE INDEX medical_certificate_appointment_idx ON medical_certificate_revisions(appointment_id,revision_number);
CREATE INDEX medical_certificate_physician_revision_idx ON medical_certificate_revisions(physician_revision_id);

CREATE TABLE medical_certificate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id UUID NOT NULL,
  revision_id UUID NOT NULL REFERENCES medical_certificate_revisions(id),
  action VARCHAR(20) NOT NULL CHECK (action IN ('LATE_ENCODING','CORRECTED','REVOKED')),
  reason VARCHAR(1000) NOT NULL CHECK (NULLIF(BTRIM(reason),'') IS NOT NULL),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  actor_snapshot JSONB NOT NULL CHECK (jsonb_typeof(actor_snapshot)='object' AND actor_snapshot<>'{}'::jsonb),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX medical_certificate_events_certificate_idx ON medical_certificate_events(certificate_id,created_at);

CREATE TABLE clinical_mutation_requests (
  actor_user_id UUID NOT NULL REFERENCES users(id),
  request_id UUID NOT NULL,
  action VARCHAR(30) NOT NULL CHECK (action IN ('ISSUE_CERTIFICATE','CORRECT_CERTIFICATE','REVOKE_CERTIFICATE','BULK_REPLACEMENT')),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  outcome JSONB NOT NULL CHECK (jsonb_typeof(outcome)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (actor_user_id,request_id)
);

CREATE INDEX appointments_cycle_occupancy_idx ON appointments(schedule_cycle_start,appointment_date,clinic_id,schedule_type)
  WHERE status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW');

CREATE FUNCTION reject_clinical_history_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'clinical history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER laboratory_checklist_events_immutable BEFORE UPDATE OR DELETE ON laboratory_checklist_events
  FOR EACH ROW EXECUTE FUNCTION reject_clinical_history_mutation();
CREATE TRIGGER medical_certificate_events_immutable BEFORE UPDATE OR DELETE ON medical_certificate_events
  FOR EACH ROW EXECUTE FUNCTION reject_clinical_history_mutation();
CREATE TRIGGER medical_certificate_physician_revisions_immutable BEFORE UPDATE OR DELETE ON medical_certificate_physician_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_clinical_history_mutation();
CREATE TRIGGER clinical_mutation_requests_immutable BEFORE UPDATE OR DELETE ON clinical_mutation_requests
  FOR EACH ROW EXECUTE FUNCTION reject_clinical_history_mutation();
CREATE TRIGGER laboratory_checklist_links_immutable BEFORE UPDATE OR DELETE ON laboratory_checklist_appointments
  FOR EACH ROW EXECUTE FUNCTION reject_clinical_history_mutation();

CREATE FUNCTION preserve_laboratory_checklist_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'version') IS DISTINCT FROM (to_jsonb(NEW)-'version') THEN
    RAISE EXCEPTION 'laboratory checklist identity and requirements are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_checklist_identity_immutable BEFORE UPDATE OR DELETE ON laboratory_checklists
  FOR EACH ROW EXECUTE FUNCTION preserve_laboratory_checklist_identity();

CREATE FUNCTION preserve_medical_certificate_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status')
     OR (OLD.status<>'ISSUED' AND NEW.status<>OLD.status) THEN
    RAISE EXCEPTION 'certificate revision content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medical_certificate_revision_immutable BEFORE UPDATE OR DELETE ON medical_certificate_revisions
  FOR EACH ROW EXECUTE FUNCTION preserve_medical_certificate_revision();

CREATE FUNCTION check_laboratory_checklist_identity(checklist UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE c laboratory_checklists%ROWTYPE; expected_count INTEGER; actual_count INTEGER;
BEGIN
  SELECT * INTO c FROM laboratory_checklists WHERE id=checklist;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM student_academic_snapshots s JOIN appointments a ON a.id=c.root_appointment_id
      WHERE s.id=c.academic_snapshot_id AND s.student_number=c.student_number AND s.academic_year_start=c.academic_year_start
        AND s.year_level=c.year_level_snapshot AND a.student_number=c.student_number
        AND a.schedule_cycle_start=c.academic_year_start AND a.scheduling_category=c.scheduling_category_snapshot
        AND a.schedule_type='LABORATORY' AND a.rescheduled_from IS NULL)
     OR NOT EXISTS (SELECT 1 FROM laboratory_checklist_appointments l WHERE l.appointment_id=c.root_appointment_id AND l.checklist_id=c.id) THEN
    RAISE EXCEPTION 'laboratory checklist provenance mismatch' USING ERRCODE='23514';
  END IF;
  expected_count := CASE WHEN c.year_level_snapshot=1 OR (c.year_level_snapshot=4 AND c.scheduling_category_snapshot='OJT') THEN 4 ELSE 3 END;
  SELECT count(*) INTO actual_count FROM laboratory_checklist_items WHERE checklist_id=c.id;
  IF actual_count<>expected_count OR EXISTS (SELECT 1 FROM laboratory_checklist_items WHERE checklist_id=c.id
      AND test_code='XRAY' AND expected_count=3)
     OR EXISTS (SELECT required FROM unnest(ARRAY['CBC','URINE','STOOL']) required
       WHERE NOT EXISTS (SELECT 1 FROM laboratory_checklist_items WHERE checklist_id=c.id AND test_code=required)) THEN
    RAISE EXCEPTION 'laboratory checklist required test set mismatch' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION check_clinical_appointment(appointment UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE a appointments%ROWTYPE; c laboratory_checklists%ROWTYPE; all_verified BOOLEAN;
  current_leaf BOOLEAN; issued_count INTEGER; result_state TEXT;
BEGIN
  SELECT * INTO a FROM appointments WHERE id=appointment;
  IF NOT FOUND THEN RETURN; END IF;
  IF a.is_published AND (a.schedule_cycle_start IS NULL OR a.scheduling_category IS NULL
      OR NOT EXISTS (SELECT 1 FROM academic_years WHERE start_year=a.schedule_cycle_start)
      OR NOT EXISTS (SELECT 1 FROM student_academic_snapshots WHERE student_number=a.student_number AND academic_year_start=a.schedule_cycle_start)) THEN
    RAISE EXCEPTION 'published appointment academic provenance missing' USING ERRCODE='23514';
  END IF;
  current_leaf := a.is_published AND a.status NOT IN ('DRAFT','RESCHEDULED','CANCELLED') AND NOT EXISTS
    (SELECT 1 FROM appointments replacement WHERE replacement.rescheduled_from=a.id AND replacement.is_published
      AND replacement.status NOT IN ('DRAFT','CANCELLED','RESCHEDULED'));
  IF EXISTS (SELECT 1 FROM student_result_submissions submission WHERE submission.appointment_id=a.id
      AND (submission.result_type<>'LABORATORY' OR a.schedule_type<>'LABORATORY'
        OR submission.student_number<>a.student_number)) THEN
    RAISE EXCEPTION 'submission appointment mismatch' USING ERRCODE='23514';
  END IF;
  SELECT checklist.* INTO c FROM laboratory_checklists checklist JOIN laboratory_checklist_appointments link ON link.checklist_id=checklist.id WHERE link.appointment_id=a.id;
  IF c.id IS NOT NULL THEN
    PERFORM check_laboratory_checklist_identity(c.id);
    IF a.schedule_type<>'LABORATORY' OR a.student_number<>c.student_number
       OR a.schedule_cycle_start IS DISTINCT FROM c.academic_year_start
       OR a.scheduling_category IS DISTINCT FROM c.scheduling_category_snapshot
       OR (a.rescheduled_from IS NULL AND a.id<>c.root_appointment_id)
       OR (a.rescheduled_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM laboratory_checklist_appointments p
           WHERE p.appointment_id=a.rescheduled_from AND p.checklist_id=c.id)) THEN
      RAISE EXCEPTION 'laboratory checklist appointment lineage mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF a.schedule_type='LABORATORY' AND a.is_published THEN
    IF c.id IS NULL THEN RAISE EXCEPTION 'published Laboratory requires checklist' USING ERRCODE='23514'; END IF;
    SELECT bool_and(verified_at IS NOT NULL) INTO all_verified FROM laboratory_checklist_items WHERE checklist_id=c.id;
    IF current_leaf AND ((a.status='COMPLETED') IS DISTINCT FROM all_verified) THEN
      RAISE EXCEPTION 'Laboratory completion must match verified required tests' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT count(*) INTO issued_count FROM medical_certificate_revisions WHERE appointment_id=a.id AND status='ISSUED';
  SELECT result_status INTO result_state FROM exam_results WHERE appointment_id=a.id;
  IF EXISTS (SELECT 1 FROM exam_results WHERE appointment_id=a.id AND (student_number IS DISTINCT FROM a.student_number OR a.schedule_type<>'PHYSICAL_EXAM'))
     OR EXISTS (SELECT 1 FROM medical_certificate_revisions WHERE appointment_id=a.id
       AND (student_number<>a.student_number OR academic_year_start IS DISTINCT FROM a.schedule_cycle_start OR a.schedule_type<>'PHYSICAL_EXAM')) THEN
    RAISE EXCEPTION 'examination certificate identity mismatch' USING ERRCODE='23514';
  END IF;
  IF (issued_count>0 AND (NOT a.is_published OR a.status<>'COMPLETED' OR result_state IS DISTINCT FROM 'COMPLETED'))
     OR (result_state='COMPLETED' AND (issued_count<>1 OR a.status<>'COMPLETED'))
     OR (a.schedule_type='PHYSICAL_EXAM' AND current_leaf AND a.status='COMPLETED' AND (issued_count<>1 OR result_state IS DISTINCT FROM 'COMPLETED'))
     OR (result_state='REQUIRES_FOLLOW_UP' AND (issued_count<>0 OR a.status='COMPLETED'))
     OR (EXISTS (SELECT 1 FROM medical_certificate_revisions WHERE appointment_id=a.id AND status='REVOKED')
         AND issued_count=0 AND (a.status='COMPLETED' OR result_state IS DISTINCT FROM 'REQUIRES_FOLLOW_UP')) THEN
    RAISE EXCEPTION 'examination completion and issued certificate must agree' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION check_clinical_appointment_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'DELETE' THEN PERFORM check_clinical_appointment(NEW.id); END IF;
  IF TG_OP<>'INSERT' AND OLD.rescheduled_from IS NOT NULL THEN PERFORM check_clinical_appointment(OLD.rescheduled_from); END IF;
  IF TG_OP<>'DELETE' AND NEW.rescheduled_from IS NOT NULL THEN PERFORM check_clinical_appointment(NEW.rescheduled_from); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER appointments_clinical_consistency AFTER INSERT OR UPDATE OR DELETE ON appointments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_clinical_appointment_trigger();

CREATE FUNCTION check_laboratory_consistency_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE checklist UUID; previous_checklist UUID; linked RECORD;
BEGIN
  IF TG_TABLE_NAME='laboratory_checklists' THEN checklist:=COALESCE(NEW.id,OLD.id);
  ELSE checklist:=COALESCE(NEW.checklist_id,OLD.checklist_id); END IF;
  IF TG_TABLE_NAME='laboratory_checklist_items' AND TG_OP='UPDATE' THEN
    previous_checklist:=OLD.checklist_id;
  END IF;
  PERFORM check_laboratory_checklist_identity(checklist);
  FOR linked IN SELECT appointment_id FROM laboratory_checklist_appointments WHERE checklist_id=checklist LOOP
    PERFORM check_clinical_appointment(linked.appointment_id);
  END LOOP;
  IF previous_checklist IS DISTINCT FROM checklist AND previous_checklist IS NOT NULL THEN
    PERFORM check_laboratory_checklist_identity(previous_checklist);
    FOR linked IN SELECT appointment_id FROM laboratory_checklist_appointments WHERE checklist_id=previous_checklist LOOP
      PERFORM check_clinical_appointment(linked.appointment_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laboratory_checklists_consistency AFTER INSERT OR UPDATE OR DELETE ON laboratory_checklists
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_laboratory_consistency_trigger();
CREATE CONSTRAINT TRIGGER laboratory_checklist_items_consistency AFTER INSERT OR UPDATE OR DELETE ON laboratory_checklist_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_laboratory_consistency_trigger();
CREATE CONSTRAINT TRIGGER laboratory_checklist_links_consistency AFTER INSERT OR UPDATE OR DELETE ON laboratory_checklist_appointments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_laboratory_consistency_trigger();

CREATE FUNCTION check_submission_consistency_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'DELETE' THEN PERFORM check_clinical_appointment(NEW.appointment_id); END IF;
  IF TG_OP<>'INSERT' AND (TG_OP='DELETE' OR OLD.appointment_id IS DISTINCT FROM NEW.appointment_id) THEN
    PERFORM check_clinical_appointment(OLD.appointment_id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER student_result_submissions_clinical_consistency AFTER INSERT OR UPDATE OR DELETE ON student_result_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_submission_consistency_trigger();

CREATE FUNCTION check_examination_consistency_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'DELETE' THEN
    IF NEW.appointment_id IS NULL THEN RAISE EXCEPTION 'examination result appointment missing' USING ERRCODE='23514'; END IF;
    PERFORM check_clinical_appointment(NEW.appointment_id);
  END IF;
  IF TG_OP<>'INSERT' THEN PERFORM check_clinical_appointment(OLD.appointment_id); END IF;
  IF TG_TABLE_NAME='medical_certificate_revisions' AND TG_OP='INSERT' THEN
    IF NEW.supersedes_revision_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM medical_certificate_revisions p WHERE p.id=NEW.supersedes_revision_id
         AND p.certificate_id=NEW.certificate_id AND p.appointment_id=NEW.appointment_id
         AND p.revision_number=NEW.revision_number-1 AND p.status IN ('SUPERSEDED','REVOKED')) THEN
      RAISE EXCEPTION 'certificate revision lineage mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER exam_results_certificate_consistency AFTER INSERT OR UPDATE OR DELETE ON exam_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_examination_consistency_trigger();
CREATE CONSTRAINT TRIGGER medical_certificate_revisions_consistency AFTER INSERT OR UPDATE OR DELETE ON medical_certificate_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_examination_consistency_trigger();
