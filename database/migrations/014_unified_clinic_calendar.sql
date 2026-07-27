-- The application is not deployed yet, so the clinic-scoped calendar is
-- intentionally replaced by an empty unified calendar. Destructive cleanup is
-- permitted only when every generated appointment has unambiguous, unprotected
-- closure lineage.

CREATE TEMP TABLE unified_calendar_cleanup_events AS
SELECT event.*
  FROM appointment_reschedule_events event
 WHERE event.cause='CLINIC_CLOSURE'
   AND event.clinic_unavailable_date_id IS NOT NULL;

CREATE TEMP TABLE unified_calendar_cleanup_generated AS
SELECT event.id AS event_id,
       event.old_laboratory_appointment_id AS original_id,
       event.new_laboratory_appointment_id AS generated_id
  FROM unified_calendar_cleanup_events event
 WHERE event.new_laboratory_appointment_id IS NOT NULL
UNION ALL
SELECT event.id,
       event.old_physical_exam_appointment_id,
       event.new_physical_exam_appointment_id
  FROM unified_calendar_cleanup_events event
 WHERE event.new_physical_exam_appointment_id IS NOT NULL;

CREATE TEMP TABLE unified_calendar_cleanup_generated_ids AS
SELECT DISTINCT generated_id AS id
  FROM unified_calendar_cleanup_generated;

CREATE TEMP TABLE unified_calendar_cleanup_original_ids AS
SELECT DISTINCT original_id AS id
  FROM unified_calendar_cleanup_generated
 WHERE original_id IS NOT NULL
   AND original_id NOT IN (SELECT id FROM unified_calendar_cleanup_generated_ids);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM unified_calendar_cleanup_generated lineage
      LEFT JOIN appointments generated ON generated.id=lineage.generated_id
     WHERE lineage.original_id IS NULL
        OR generated.id IS NULL
        OR generated.rescheduled_from IS DISTINCT FROM lineage.original_id
  ) THEN
    RAISE EXCEPTION 'Unified clinic calendar cleanup preflight failed: ambiguous replacement lineage';
  END IF;

  IF EXISTS (
    SELECT generated.id
      FROM unified_calendar_cleanup_generated_ids lineage
      JOIN appointments generated ON generated.id=lineage.id
     WHERE generated.status='COMPLETED'
        OR generated.is_manually_locked
  ) THEN
    RAISE EXCEPTION 'Unified clinic calendar cleanup preflight failed: completed or protected replacement';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM student_result_submissions submission
      JOIN unified_calendar_cleanup_generated_ids lineage
        ON lineage.id=submission.appointment_id
     WHERE submission.status='FINALIZED'
  ) OR EXISTS (
    SELECT 1
      FROM exam_results result
      JOIN unified_calendar_cleanup_generated_ids lineage
        ON lineage.id=result.appointment_id
     WHERE result.result_status<>'PENDING_UPLOAD'
  ) OR EXISTS (
    SELECT 1
      FROM laboratory_results result
      JOIN unified_calendar_cleanup_generated_ids lineage
        ON lineage.id=result.appointment_id
     WHERE result.result_status<>'PENDING_UPLOAD'
  ) THEN
    RAISE EXCEPTION 'Unified clinic calendar cleanup preflight failed: protected result data exists';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM appointments child
      JOIN unified_calendar_cleanup_generated_ids lineage
        ON lineage.id=child.rescheduled_from
     WHERE child.id NOT IN (SELECT id FROM unified_calendar_cleanup_generated_ids)
  ) OR EXISTS (
    SELECT 1
      FROM appointment_reschedule_events event
      JOIN unified_calendar_cleanup_generated_ids lineage
        ON lineage.id IN (
          event.old_laboratory_appointment_id,
          event.new_laboratory_appointment_id,
          event.old_physical_exam_appointment_id,
          event.new_physical_exam_appointment_id
        )
     WHERE event.id NOT IN (SELECT id FROM unified_calendar_cleanup_events)
  ) THEN
    RAISE EXCEPTION 'Unified clinic calendar cleanup preflight failed: replacement has external lineage';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unified_calendar_cleanup_original_ids lineage
      LEFT JOIN appointments original ON original.id=lineage.id
     WHERE original.id IS NULL
        OR original.status<>'RESCHEDULED'
        OR original.is_manually_locked
  ) OR EXISTS (
    SELECT 1
      FROM student_result_submissions submission
      JOIN unified_calendar_cleanup_original_ids lineage
        ON lineage.id=submission.appointment_id
     WHERE submission.status='FINALIZED'
  ) OR EXISTS (
    SELECT 1
      FROM exam_results result
      JOIN unified_calendar_cleanup_original_ids lineage
        ON lineage.id=result.appointment_id
     WHERE result.result_status<>'PENDING_UPLOAD'
  ) OR EXISTS (
    SELECT 1
      FROM laboratory_results result
      JOIN unified_calendar_cleanup_original_ids lineage
        ON lineage.id=result.appointment_id
     WHERE result.result_status<>'PENDING_UPLOAD'
  ) THEN
    RAISE EXCEPTION 'Unified clinic calendar cleanup preflight failed: original appointment is protected or ambiguous';
  END IF;
END
$$;

DELETE FROM student_portal_notifications notification
 WHERE notification.metadata->>'clinicUnavailableDateId' IN (
   SELECT clinic_unavailable_date_id::text FROM unified_calendar_cleanup_events
 )
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(notification.metadata->'clinicUnavailableDateIds')='array'
              THEN notification.metadata->'clinicUnavailableDateIds'
            ELSE '[]'::jsonb
          END
        ) AS metadata_date(id)
       WHERE metadata_date.id IN (
         SELECT clinic_unavailable_date_id::text FROM unified_calendar_cleanup_events
       )
    );

DELETE FROM audit_logs audit
 WHERE audit.entity_id IN (
   SELECT id::text FROM clinic_unavailable_dates
 )
    OR audit.metadata->>'clinicUnavailableDateId' IN (
      SELECT id::text FROM clinic_unavailable_dates
    )
    OR audit.entity_id IN (
      SELECT created_batch_id::text
        FROM clinic_unavailable_dates
       WHERE created_batch_id IS NOT NULL
    )
    OR audit.metadata->>'batchId' IN (
      SELECT created_batch_id::text
        FROM clinic_unavailable_dates
       WHERE created_batch_id IS NOT NULL
    );

DELETE FROM appointment_reschedule_events event
 WHERE event.id IN (SELECT id FROM unified_calendar_cleanup_events);

DELETE FROM student_result_submissions submission
 WHERE submission.appointment_id IN (SELECT id FROM unified_calendar_cleanup_generated_ids);
DELETE FROM exam_results result
 WHERE result.appointment_id IN (SELECT id FROM unified_calendar_cleanup_generated_ids);
DELETE FROM laboratory_results result
 WHERE result.appointment_id IN (SELECT id FROM unified_calendar_cleanup_generated_ids);
DELETE FROM appointment_status_logs status_log
 WHERE status_log.appointment_id IN (SELECT id FROM unified_calendar_cleanup_generated_ids);
DELETE FROM appointments appointment
 WHERE appointment.id IN (SELECT id FROM unified_calendar_cleanup_generated_ids);

UPDATE appointments appointment
   SET status='PENDING',
       is_published=TRUE,
       updated_at=NOW()
 WHERE appointment.id IN (SELECT id FROM unified_calendar_cleanup_original_ids);

DELETE FROM clinic_unavailable_dates;

ALTER TABLE appointment_reschedule_events
  DROP COLUMN clinic_unavailable_date_id;
DROP TABLE clinic_unavailable_dates;

DROP INDEX appointments_one_active_service_cycle_idx;
ALTER TABLE appointments
  DROP CONSTRAINT appointments_status_check,
  ADD CONSTRAINT appointments_status_check
    CHECK (status IN (
      'DRAFT','PENDING','COMPLETED','NO_SHOW','RESCHEDULED','CANCELLED','AWAITING_RESCHEDULE'
    ));
CREATE UNIQUE INDEX appointments_one_active_service_cycle_idx
  ON appointments (student_number, clinic_id, schedule_type, schedule_cycle_start)
  WHERE status IN ('DRAFT','PENDING','AWAITING_RESCHEDULE');

CREATE TABLE clinic_closure_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  category VARCHAR(40) NOT NULL
    CHECK (category IN (
      'HOLIDAY','CLOSURE','EMERGENCY_CLOSURE','MAINTENANCE','STAFF_UNAVAILABILITY'
    )),
  reason TEXT NOT NULL CHECK (NULLIF(BTRIM(reason),'') IS NOT NULL),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creation_batch_id UUID NOT NULL,
  CHECK (end_date>=start_date)
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
     OR NEW.creation_batch_id IS DISTINCT FROM OLD.creation_batch_id THEN
    RAISE EXCEPTION 'Clinic closure group boundaries and cause are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinic_closure_groups_boundary_immutable
  BEFORE UPDATE ON clinic_closure_groups
  FOR EACH ROW EXECUTE FUNCTION preserve_clinic_closure_group_boundary();
CREATE TRIGGER clinic_closure_groups_updated_at
  BEFORE UPDATE ON clinic_closure_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE clinic_unavailable_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closure_group_id UUID NOT NULL REFERENCES clinic_closure_groups(id),
  blocked_date DATE NOT NULL,
  reopened_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES users(id),
  reopening_batch_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clinic_unavailable_dates_reopening_complete CHECK (
    (reopened_at IS NULL AND reopened_by IS NULL AND reopening_batch_id IS NULL)
    OR
    (reopened_at IS NOT NULL AND reopened_by IS NOT NULL AND reopening_batch_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX clinic_unavailable_dates_one_active_day_idx
  ON clinic_unavailable_dates(blocked_date)
  WHERE reopened_at IS NULL;
CREATE INDEX clinic_unavailable_dates_group_idx
  ON clinic_unavailable_dates(closure_group_id,blocked_date);
CREATE TRIGGER clinic_unavailable_dates_updated_at
  BEFORE UPDATE ON clinic_unavailable_dates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE clinic_closure_manual_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  closure_group_id UUID NOT NULL REFERENCES clinic_closure_groups(id),
  schedule_pair_id UUID,
  schedule_cycle_start INTEGER NOT NULL CHECK (schedule_cycle_start BETWEEN 2020 AND 2100),
  affected_laboratory_appointment_id UUID REFERENCES appointments(id),
  affected_physical_exam_appointment_id UUID REFERENCES appointments(id),
  reason_code VARCHAR(60) NOT NULL CHECK (reason_code IN (
    'PHYSICAL_COMPLETED_BEFORE_LABORATORY',
    'APPOINTMENT_MANUALLY_LOCKED',
    'PROTECTED_RESULTS_EXIST',
    'PAIR_MISSING_OR_INCONSISTENT',
    'NO_REPLACEMENT_CAPACITY',
    'CONCURRENT_APPOINTMENT_CHANGE',
    'UNSAFE_RESTORATION'
  )),
  reason_message TEXT NOT NULL CHECK (NULLIF(BTRIM(reason_message),'') IS NOT NULL),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  optimistic_token UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  resolution_action VARCHAR(40) CHECK (
    resolution_action IS NULL OR resolution_action IN ('ASSIGN_REPLACEMENT','KEEP_CURRENT_REPLACEMENT')
  ),
  resolution_details JSONB,
  CONSTRAINT clinic_closure_manual_cases_resolution_complete CHECK (
    (status='OPEN' AND resolved_at IS NULL AND resolved_by IS NULL
      AND resolution_action IS NULL AND resolution_details IS NULL)
    OR
    (status='RESOLVED' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND resolution_action IS NOT NULL AND resolution_details IS NOT NULL)
  )
);
CREATE INDEX clinic_closure_manual_cases_open_idx
  ON clinic_closure_manual_cases(status,created_at,id);
CREATE TRIGGER clinic_closure_manual_cases_updated_at
  BEFORE UPDATE ON clinic_closure_manual_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE appointment_reschedule_events
  ADD COLUMN closure_group_id UUID REFERENCES clinic_closure_groups(id),
  ADD COLUMN schedule_cycle_start INTEGER CHECK (schedule_cycle_start BETWEEN 2020 AND 2100),
  ADD COLUMN strategy VARCHAR(40) CHECK (
    strategy IS NULL OR strategy IN (
      'MOVE_COMPLETE_PAIR','MOVE_PHYSICAL_ONLY','MANUAL_RESOLUTION_REQUIRED'
    )
  ),
  ADD COLUMN outcome VARCHAR(40) CHECK (
    outcome IS NULL OR outcome IN (
      'REPLACED','AWAITING_RESCHEDULE','COMPLETION_PRESERVED','RESTORED','MANUALLY_RESOLVED'
    )
  ),
  ADD COLUMN restoration_decision VARCHAR(40),
  ADD COLUMN restoration_details JSONB,
  ADD COLUMN manual_case_id UUID REFERENCES clinic_closure_manual_cases(id),
  ADD CONSTRAINT appointment_reschedule_events_closure_complete CHECK (
    cause<>'CLINIC_CLOSURE'
    OR (closure_group_id IS NOT NULL AND schedule_cycle_start IS NOT NULL
        AND strategy IS NOT NULL AND outcome IS NOT NULL)
  );
CREATE INDEX appointment_reschedule_events_closure_idx
  ON appointment_reschedule_events(closure_group_id,student_number,schedule_cycle_start);

CREATE TABLE appointment_reschedule_event_unavailable_dates (
  event_id UUID NOT NULL REFERENCES appointment_reschedule_events(id) ON DELETE CASCADE,
  unavailable_date_id UUID NOT NULL REFERENCES clinic_unavailable_dates(id),
  PRIMARY KEY(event_id,unavailable_date_id)
);
CREATE INDEX appointment_reschedule_event_unavailable_dates_date_idx
  ON appointment_reschedule_event_unavailable_dates(unavailable_date_id,event_id);

CREATE TABLE clinic_calendar_requests (
  request_id UUID PRIMARY KEY,
  payload_hash CHAR(64) NOT NULL,
  batch_id UUID NOT NULL UNIQUE,
  result JSONB NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE student_portal_notifications ADD COLUMN event_key TEXT;
ALTER TABLE email_outbox ADD COLUMN event_key TEXT;
CREATE UNIQUE INDEX student_portal_notifications_event_key_idx
  ON student_portal_notifications(event_key) WHERE event_key IS NOT NULL;
CREATE UNIQUE INDEX email_outbox_event_key_idx
  ON email_outbox(event_key) WHERE event_key IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM clinic_unavailable_dates WHERE reopened_at IS NULL) THEN
    RAISE EXCEPTION 'Unified clinic calendar must start with zero active blocked dates';
  END IF;
END
$$;

DROP TABLE unified_calendar_cleanup_original_ids;
DROP TABLE unified_calendar_cleanup_generated_ids;
DROP TABLE unified_calendar_cleanup_generated;
DROP TABLE unified_calendar_cleanup_events;
