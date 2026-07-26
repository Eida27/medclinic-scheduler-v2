ALTER TABLE clinic_unavailable_dates
  ADD COLUMN created_batch_id UUID,
  ADD COLUMN unblocked_at TIMESTAMPTZ,
  ADD COLUMN unblocked_by UUID REFERENCES users(id),
  ADD COLUMN unblocked_batch_id UUID,
  ADD CONSTRAINT clinic_unavailable_dates_unblock_complete
    CHECK (
      (unblocked_at IS NULL AND unblocked_by IS NULL AND unblocked_batch_id IS NULL)
      OR
      (unblocked_at IS NOT NULL AND unblocked_by IS NOT NULL AND unblocked_batch_id IS NOT NULL)
    );

ALTER TABLE appointment_reschedule_events
  ADD COLUMN block_batch_id UUID,
  ADD COLUMN restored_at TIMESTAMPTZ,
  ADD COLUMN restored_by UUID REFERENCES users(id),
  ADD COLUMN restoration_batch_id UUID,
  ADD CONSTRAINT appointment_reschedule_events_restore_complete
    CHECK (
      (restored_at IS NULL AND restored_by IS NULL AND restoration_batch_id IS NULL)
      OR
      (restored_at IS NOT NULL AND restored_by IS NOT NULL AND restoration_batch_id IS NOT NULL)
    );

CREATE TEMP TABLE clinic_unavailable_date_split_map (
  source_id UUID NOT NULL,
  target_id UUID NOT NULL,
  blocked_date DATE NOT NULL,
  PRIMARY KEY (source_id, blocked_date),
  UNIQUE (target_id)
) ON COMMIT DROP;

INSERT INTO clinic_unavailable_date_split_map (source_id, target_id, blocked_date)
SELECT unavailable.id,
       CASE
         WHEN day::date = unavailable.start_date THEN unavailable.id
         ELSE gen_random_uuid()
       END,
       day::date
  FROM clinic_unavailable_dates unavailable
 CROSS JOIN LATERAL generate_series(
   unavailable.start_date,
   unavailable.end_date,
   INTERVAL '1 day'
 ) AS day
 WHERE unavailable.unblocked_at IS NULL
   AND unavailable.start_date <> unavailable.end_date;

INSERT INTO clinic_unavailable_dates (
  id, clinic_id, start_date, end_date, category, reason,
  created_by, created_at, updated_at, created_batch_id
)
SELECT split.target_id,
       source.clinic_id,
       split.blocked_date,
       split.blocked_date,
       source.category,
       source.reason,
       source.created_by,
       source.created_at,
       source.updated_at,
       source.created_batch_id
  FROM clinic_unavailable_date_split_map split
  JOIN clinic_unavailable_dates source ON source.id=split.source_id
 WHERE split.target_id <> split.source_id;

WITH event_block_date AS (
  SELECT event.id AS event_id,
         event.clinic_unavailable_date_id AS source_id,
         CASE clinic.code
           WHEN 'KABALAKA_CLINIC' THEN old_laboratory.appointment_date
           WHEN 'CPU_CLINIC' THEN old_physical.appointment_date
         END AS blocked_date
    FROM appointment_reschedule_events event
    JOIN clinic_unavailable_dates unavailable
      ON unavailable.id=event.clinic_unavailable_date_id
    JOIN clinics clinic ON clinic.id=unavailable.clinic_id
    LEFT JOIN appointments old_laboratory
      ON old_laboratory.id=event.old_laboratory_appointment_id
    LEFT JOIN appointments old_physical
      ON old_physical.id=event.old_physical_exam_appointment_id
   WHERE unavailable.unblocked_at IS NULL
     AND unavailable.start_date <> unavailable.end_date
)
UPDATE appointment_reschedule_events event
   SET clinic_unavailable_date_id=split.target_id
  FROM event_block_date cause
  JOIN clinic_unavailable_date_split_map split
    ON split.source_id=cause.source_id
   AND split.blocked_date=cause.blocked_date
 WHERE event.id=cause.event_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM appointment_reschedule_events event
      JOIN clinic_unavailable_dates unavailable
        ON unavailable.id=event.clinic_unavailable_date_id
      JOIN clinics clinic ON clinic.id=unavailable.clinic_id
      LEFT JOIN appointments old_laboratory
        ON old_laboratory.id=event.old_laboratory_appointment_id
      LEFT JOIN appointments old_physical
        ON old_physical.id=event.old_physical_exam_appointment_id
     WHERE unavailable.unblocked_at IS NULL
       AND unavailable.start_date <> unavailable.end_date
       AND NOT EXISTS (
         SELECT 1
           FROM clinic_unavailable_date_split_map split
          WHERE split.source_id=unavailable.id
            AND split.blocked_date=CASE clinic.code
              WHEN 'KABALAKA_CLINIC' THEN old_laboratory.appointment_date
              WHEN 'CPU_CLINIC' THEN old_physical.appointment_date
            END
       )
  ) THEN
    RAISE EXCEPTION 'Unable to normalize clinic unavailable-date reschedule history';
  END IF;
END
$$;

UPDATE clinic_unavailable_dates unavailable
   SET end_date=unavailable.start_date
 WHERE unavailable.id IN (
   SELECT DISTINCT source_id FROM clinic_unavailable_date_split_map
 );

ALTER TABLE clinic_unavailable_dates
  ADD CONSTRAINT clinic_unavailable_dates_active_single_day
    CHECK (unblocked_at IS NOT NULL OR start_date=end_date);

CREATE UNIQUE INDEX clinic_unavailable_dates_one_active_day_idx
  ON clinic_unavailable_dates (clinic_id, start_date)
  WHERE unblocked_at IS NULL;

CREATE INDEX appointment_reschedule_events_active_block_idx
  ON appointment_reschedule_events (clinic_unavailable_date_id, restored_at)
  WHERE clinic_unavailable_date_id IS NOT NULL;
