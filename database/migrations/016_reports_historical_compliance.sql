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
  source_import_group_id UUID NOT NULL
    REFERENCES schedule_import_groups(id)
    ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
CREATE INDEX IF NOT EXISTS student_academic_snapshots_source_import_group_idx
  ON student_academic_snapshots (source_import_group_id);
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
      program_name TEXT, year_level INTEGER, source_import_group_id UUID
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
    source_import_group_id
  )
  SELECT candidate.student_number,candidate.academic_year_start,candidate.student_name,
         candidate.college_id,candidate.college_name,candidate.program_id,
         candidate.program_code,candidate.program_name,candidate.year_level,
         candidate.source_import_group_id
    FROM jsonb_to_recordset(candidates) AS candidate(
      student_number TEXT, academic_year_start INTEGER, student_name TEXT,
      college_id UUID, college_name TEXT, program_id UUID, program_code TEXT,
      program_name TEXT, year_level INTEGER, source_import_group_id UUID
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
