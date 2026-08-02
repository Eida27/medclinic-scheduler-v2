CREATE TABLE IF NOT EXISTS academic_years (
  start_year INTEGER PRIMARY KEY CHECK (start_year BETWEEN 2020 AND 2100),
  label VARCHAR(20) GENERATED ALWAYS AS (
    start_year::text || '–' || (start_year + 1)::text
  ) STORED,
  closing_date DATE NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT academic_years_closing_date_year CHECK (
    EXTRACT(YEAR FROM closing_date)::integer IN (start_year, start_year + 1)
  )
);

DROP TRIGGER IF EXISTS academic_years_updated_at ON academic_years;
CREATE TRIGGER academic_years_updated_at
  BEFORE UPDATE ON academic_years
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS student_academic_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL,
  academic_year_start INTEGER NOT NULL REFERENCES academic_years(start_year),
  student_name VARCHAR(350) NOT NULL,
  college_id UUID,
  college_name VARCHAR(150) NOT NULL,
  program_id UUID,
  program_code VARCHAR(30),
  program_name VARCHAR(150) NOT NULL,
  year_level INTEGER CHECK (year_level BETWEEN 1 AND 6),
  source_import_group_id UUID,
  source_type VARCHAR(30) NOT NULL,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT student_academic_snapshots_source_type_check CHECK (
    source_type IN (
      'VERIFIED_HISTORICAL',
      'RECOVERED_HISTORICAL',
      'MIGRATED_INCOMPLETE'
    )
  ),
  CONSTRAINT student_academic_snapshots_student_year_key
    UNIQUE (student_number, academic_year_start)
);

CREATE OR REPLACE FUNCTION reject_student_academic_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'student academic snapshots are immutable'
    USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS student_academic_snapshots_immutable
  ON student_academic_snapshots;
CREATE TRIGGER student_academic_snapshots_immutable
  BEFORE UPDATE OR DELETE ON student_academic_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_student_academic_snapshot_mutation();

CREATE INDEX IF NOT EXISTS student_academic_snapshots_year_student_idx
  ON student_academic_snapshots (academic_year_start, student_number);
CREATE INDEX IF NOT EXISTS student_academic_snapshots_reporting_idx
  ON student_academic_snapshots (
    academic_year_start, college_id, program_id, year_level, student_number
  );
CREATE INDEX IF NOT EXISTS appointments_historical_reporting_idx
  ON appointments (
    schedule_cycle_start, student_number, schedule_type, appointment_date DESC
  )
  WHERE is_published=TRUE;

CREATE OR REPLACE FUNCTION ensure_student_academic_snapshots(
  actor_user_id UUID,
  candidates JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  conflicts JSONB;
  candidate_count INTEGER;
  inserted_count INTEGER;
  conflict_year INTEGER;
  conflict_entity_id TEXT;
BEGIN
  IF jsonb_typeof(candidates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'snapshot candidates must be a JSON array'
      USING ERRCODE='22023';
  END IF;
  candidate_count := jsonb_array_length(candidates);
  IF candidate_count=0 THEN
    RETURN jsonb_build_object(
      'outcome','CREATED_OR_IDENTICAL','insertedCount',0,'identicalCount',0
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(candidates) AS candidate(
        student_number TEXT, academic_year_start INTEGER
      )
      LEFT JOIN academic_years year
        ON year.start_year=candidate.academic_year_start
     WHERE year.start_year IS NULL
  ) THEN
    RAISE EXCEPTION 'academic year is not configured'
      USING ERRCODE='23503';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(lock_key))
    FROM (
      SELECT DISTINCT candidate.student_number || ':' || candidate.academic_year_start AS lock_key
        FROM jsonb_to_recordset(candidates) AS candidate(
          student_number TEXT, academic_year_start INTEGER
        )
       ORDER BY lock_key
    ) locks;

  SELECT jsonb_agg(
           jsonb_build_object(
             'studentNumber',candidate.student_number,
             'academicYearStart',candidate.academic_year_start,
             'fields',to_jsonb(ARRAY_REMOVE(ARRAY[
               CASE WHEN snapshot.student_name IS DISTINCT FROM candidate.student_name THEN 'studentName' END,
               CASE WHEN snapshot.college_id IS DISTINCT FROM candidate.college_id THEN 'collegeId' END,
               CASE WHEN snapshot.college_name IS DISTINCT FROM candidate.college_name THEN 'collegeName' END,
               CASE WHEN snapshot.program_id IS DISTINCT FROM candidate.program_id THEN 'programId' END,
               CASE WHEN snapshot.program_code IS DISTINCT FROM candidate.program_code THEN 'programCode' END,
               CASE WHEN snapshot.program_name IS DISTINCT FROM candidate.program_name THEN 'programName' END,
               CASE WHEN snapshot.year_level IS DISTINCT FROM candidate.year_level THEN 'yearLevel' END
             ],NULL))
           ) ORDER BY candidate.student_number,candidate.academic_year_start
         )
    INTO conflicts
    FROM jsonb_to_recordset(candidates) AS candidate(
      student_number TEXT, academic_year_start INTEGER, student_name TEXT,
      college_id UUID, college_name TEXT, program_id UUID, program_code TEXT,
      program_name TEXT, year_level INTEGER, source_import_group_id UUID,
      source_type TEXT, source_metadata JSONB
    )
    JOIN student_academic_snapshots snapshot
      ON snapshot.student_number=candidate.student_number
     AND snapshot.academic_year_start=candidate.academic_year_start
   WHERE snapshot.student_name IS DISTINCT FROM candidate.student_name
      OR snapshot.college_id IS DISTINCT FROM candidate.college_id
      OR snapshot.college_name IS DISTINCT FROM candidate.college_name
      OR snapshot.program_id IS DISTINCT FROM candidate.program_id
      OR snapshot.program_code IS DISTINCT FROM candidate.program_code
      OR snapshot.program_name IS DISTINCT FROM candidate.program_name
      OR snapshot.year_level IS DISTINCT FROM candidate.year_level;

  IF conflicts IS NOT NULL THEN
    SELECT CASE WHEN COUNT(DISTINCT value->>'academicYearStart')=1
                THEN MIN((value->>'academicYearStart')::integer) END
      INTO conflict_year
      FROM jsonb_array_elements(conflicts);
    conflict_entity_id := CASE WHEN jsonb_array_length(conflicts)=1
      THEN (conflicts->0->>'studentNumber') || ':' || (conflicts->0->>'academicYearStart')
      ELSE NULL END;
    INSERT INTO audit_logs (
      actor_user_id,action,entity_type,entity_id,metadata
    ) VALUES (
      actor_user_id,'SNAPSHOT_CONFLICT_DETECTED','student_academic_snapshot',
      conflict_entity_id,
      jsonb_build_object(
        'academicYearStart',conflict_year,
        'academicYearStarts',(
          SELECT jsonb_agg(year ORDER BY year)
            FROM (
              SELECT DISTINCT (value->>'academicYearStart')::integer AS year
                FROM jsonb_array_elements(conflicts)
            ) years
        ),
        'conflictCount',jsonb_array_length(conflicts),
        'conflicts',conflicts
      )
    );
    RETURN jsonb_build_object('outcome','CONFLICT','conflicts',conflicts);
  END IF;

  INSERT INTO student_academic_snapshots (
    student_number,academic_year_start,student_name,
    college_id,college_name,program_id,program_code,program_name,year_level,
    source_import_group_id,source_type,source_metadata
  )
  SELECT candidate.student_number,candidate.academic_year_start,candidate.student_name,
         candidate.college_id,candidate.college_name,candidate.program_id,
         candidate.program_code,candidate.program_name,candidate.year_level,
         candidate.source_import_group_id,candidate.source_type,
         COALESCE(candidate.source_metadata,'{}'::jsonb)
    FROM jsonb_to_recordset(candidates) AS candidate(
      student_number TEXT, academic_year_start INTEGER, student_name TEXT,
      college_id UUID, college_name TEXT, program_id UUID, program_code TEXT,
      program_name TEXT, year_level INTEGER, source_import_group_id UUID,
      source_type TEXT, source_metadata JSONB
    )
  ON CONFLICT (student_number,academic_year_start) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN jsonb_build_object(
    'outcome','CREATED_OR_IDENTICAL',
    'insertedCount',inserted_count,
    'identicalCount',candidate_count-inserted_count
  );
END;
$$;

WITH cycle_owner_candidates AS (
  SELECT appointment.schedule_cycle_start AS start_year,
         import_group.created_by AS owner_id,
         1 AS source_priority,
         COALESCE(batch.published_at,import_group.accepted_at) AS evidence_time,
         import_group.id::text AS source_id
    FROM appointments appointment
    JOIN schedule_batches batch
      ON batch.id=appointment.batch_id
     AND batch.status='PUBLISHED'
    JOIN schedule_import_groups import_group
      ON import_group.id=batch.import_group_id
     AND import_group.academic_year_start=appointment.schedule_cycle_start
   WHERE appointment.is_published=TRUE

  UNION ALL

  SELECT appointment.schedule_cycle_start,
         COALESCE(
           CASE WHEN batch.status='PUBLISHED' THEN batch.published_by END,
           CASE WHEN batch.status='PUBLISHED' THEN batch.created_by END,
           appointment.created_by
         ),
         2,
         COALESCE(
           CASE WHEN batch.status='PUBLISHED' THEN batch.published_at END,
           appointment.appointment_date::timestamptz
         ),
         COALESCE(
           CASE WHEN batch.status='PUBLISHED' THEN batch.id::text END,
           appointment.id::text
         )
    FROM appointments appointment
    LEFT JOIN schedule_batches batch ON batch.id=appointment.batch_id
   WHERE appointment.is_published=TRUE
     AND COALESCE(
       CASE WHEN batch.status='PUBLISHED' THEN batch.published_by END,
       CASE WHEN batch.status='PUBLISHED' THEN batch.created_by END,
       appointment.created_by
     ) IS NOT NULL
),
ranked_cycle_owners AS (
  SELECT start_year,owner_id,
         ROW_NUMBER() OVER (
           PARTITION BY start_year
           ORDER BY source_priority,evidence_time NULLS LAST,source_id,owner_id
         ) AS owner_rank
    FROM cycle_owner_candidates
),
cycle_owners AS (
  SELECT start_year,owner_id
    FROM ranked_cycle_owners
   WHERE owner_rank=1
)
INSERT INTO academic_years (
  start_year, closing_date, created_by, updated_by
)
SELECT owner.start_year,
       make_date(owner.start_year + 1,7,31),
       owner.owner_id,
       owner.owner_id
  FROM cycle_owners owner
ON CONFLICT (start_year) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT DISTINCT appointment.schedule_cycle_start
      FROM appointments appointment
      LEFT JOIN academic_years year
        ON year.start_year=appointment.schedule_cycle_start
     WHERE appointment.is_published=TRUE
       AND year.start_year IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot derive academic-year ownership from published source records';
  END IF;
END
$$;

WITH reporting_population AS (
  SELECT DISTINCT appointment.student_number,
                  appointment.schedule_cycle_start AS academic_year_start
    FROM appointments appointment
   WHERE appointment.is_published=TRUE
),
recovery_candidates AS (
  SELECT population.student_number,
         population.academic_year_start,
         import_group.id AS source_import_group_id,
         COALESCE(batch.published_at, import_group.accepted_at) AS evidence_time,
         ROW_NUMBER() OVER (
           PARTITION BY population.student_number, population.academic_year_start
           ORDER BY COALESCE(batch.published_at, import_group.accepted_at) DESC,
                    import_group.id
         ) AS source_rank
    FROM reporting_population population
    JOIN appointments appointment
      ON appointment.student_number=population.student_number
     AND appointment.schedule_cycle_start=population.academic_year_start
     AND appointment.is_published=TRUE
    JOIN schedule_batches batch
      ON batch.id=appointment.batch_id
     AND batch.status='PUBLISHED'
     AND batch.import_group_id IS NOT NULL
    JOIN schedule_import_groups import_group
      ON import_group.id=batch.import_group_id
     AND import_group.academic_year_start=population.academic_year_start
    JOIN students student
      ON student.student_number=population.student_number
    JOIN colleges college ON college.id=student.college_id
    JOIN programs program ON program.id=student.program_id
   WHERE college.updated_at <= COALESCE(batch.published_at, import_group.accepted_at)
     AND program.updated_at <= COALESCE(batch.published_at, import_group.accepted_at)
     AND NOT EXISTS (
       SELECT 1
         FROM audit_logs audit
        WHERE audit.entity_type='student'
          AND audit.entity_id=population.student_number
          AND audit.created_at > COALESCE(batch.published_at, import_group.accepted_at)
          AND NOT (
            audit.action='STUDENT_PROFILE_UPDATED_BY_IMPORT'
            AND audit.metadata->>'importId'=import_group.id::text
          )
     )
),
best_recovery AS (
  SELECT student_number, academic_year_start, source_import_group_id, evidence_time
    FROM recovery_candidates
   WHERE source_rank=1
),
snapshot_rows AS (
  SELECT population.student_number,
         population.academic_year_start,
         CONCAT(
           BTRIM(student.last_name), ', ', BTRIM(student.first_name),
           CASE WHEN NULLIF(BTRIM(student.middle_name), '') IS NULL
             THEN '' ELSE CONCAT(' ', BTRIM(student.middle_name)) END,
           CASE WHEN NULLIF(BTRIM(student.suffix), '') IS NULL
             THEN '' ELSE CONCAT(' (', BTRIM(student.suffix), ')') END
         ) AS student_name,
         student.college_id,
         college.name AS college_name,
         student.program_id,
         program.code AS program_code,
         program.name AS program_name,
         student.year_level,
         recovery.source_import_group_id,
         CASE WHEN recovery.source_import_group_id IS NULL
           THEN 'MIGRATED_INCOMPLETE'
           ELSE 'RECOVERED_HISTORICAL'
         END AS source_type,
         CASE WHEN recovery.source_import_group_id IS NULL
           THEN jsonb_build_object(
             'migration', '016_reports_historical_compliance',
             'provenance', 'CURRENT_PROFILE_FALLBACK',
             'historicalEvidenceComplete', FALSE
           )
           ELSE jsonb_build_object(
             'migration', '016_reports_historical_compliance',
             'provenance', 'PUBLISHED_IMPORT_GROUP',
             'historicalEvidenceComplete', TRUE,
             'evidenceTime', recovery.evidence_time
           )
         END AS source_metadata
    FROM reporting_population population
    JOIN students student ON student.student_number=population.student_number
    JOIN colleges college ON college.id=student.college_id
    JOIN programs program ON program.id=student.program_id
    LEFT JOIN best_recovery recovery
      ON recovery.student_number=population.student_number
     AND recovery.academic_year_start=population.academic_year_start
)
SELECT ensure_student_academic_snapshots(
  (SELECT id FROM users ORDER BY id LIMIT 1),
  COALESCE(jsonb_agg(jsonb_build_object(
    'student_number',student_number,
    'academic_year_start',academic_year_start,
    'student_name',student_name,
    'college_id',college_id,
    'college_name',college_name,
    'program_id',program_id,
    'program_code',program_code,
    'program_name',program_name,
    'year_level',year_level,
    'source_import_group_id',source_import_group_id,
    'source_type',source_type,
    'source_metadata',source_metadata
  )), '[]'::jsonb)
)
  FROM snapshot_rows;

INSERT INTO audit_logs (
  actor_user_id, action, entity_type, entity_id, metadata
)
SELECT owner.id,
       'HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED',
       'database_migration',
       '016_reports_historical_compliance',
       jsonb_build_object(
         'migration', '016_reports_historical_compliance',
         'academicYearCount', (SELECT COUNT(*) FROM academic_years),
         'snapshotCount', (SELECT COUNT(*) FROM student_academic_snapshots),
         'verifiedHistoricalCount', (
           SELECT COUNT(*) FROM student_academic_snapshots
            WHERE source_type='VERIFIED_HISTORICAL'
         ),
         'recoveredHistoricalCount', (
           SELECT COUNT(*) FROM student_academic_snapshots
            WHERE source_type='RECOVERED_HISTORICAL'
         ),
         'migratedIncompleteCount', (
           SELECT COUNT(*) FROM student_academic_snapshots
            WHERE source_type='MIGRATED_INCOMPLETE'
         ),
         'closingDateRule', 'JULY_31_OF_START_YEAR_PLUS_ONE',
         'recoveryRule', 'UNCHANGED_PUBLISHED_IMPORT_GROUP_EVIDENCE',
         'fallbackRule', 'CURRENT_PROFILE_MARKED_INCOMPLETE'
       )
  FROM (
    SELECT COALESCE(
      (
        SELECT created_by
          FROM academic_years
         ORDER BY start_year
         LIMIT 1
      ),
      (
        SELECT id
          FROM users
         ORDER BY id
         LIMIT 1
      )
    ) AS id
  ) owner
 WHERE NOT EXISTS (
   SELECT 1 FROM audit_logs
    WHERE action='HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED'
      AND entity_type='database_migration'
      AND entity_id='016_reports_historical_compliance'
 );
