CREATE TABLE students (
  student_number VARCHAR(20) PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  middle_name VARCHAR(100),
  last_name VARCHAR(100) NOT NULL,
  suffix VARCHAR(20),
  college_id UUID NOT NULL REFERENCES colleges(id),
  program_id UUID NOT NULL,
  year_level INTEGER CHECK (year_level BETWEEN 1 AND 6),
  section VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT students_program_college_fk FOREIGN KEY (program_id, college_id)
    REFERENCES programs(id, college_id)
);

CREATE TABLE schedule_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  batch_name VARCHAR(150) NOT NULL,
  college_id UUID REFERENCES colleges(id),
  program_id UUID,
  submitted_by_name VARCHAR(150),
  description TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'VALIDATED', 'GENERATED', 'PUBLISHED', 'CANCELLED')),
  validation_summary JSONB,
  validated_by UUID REFERENCES users(id),
  validated_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  override_reason TEXT,
  overridden_by UUID REFERENCES users(id),
  overridden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT batches_program_college_fk FOREIGN KEY (program_id, college_id)
    REFERENCES programs(id, college_id),
  CONSTRAINT batches_override_complete CHECK (
    (override_reason IS NULL AND overridden_by IS NULL AND overridden_at IS NULL)
    OR (NULLIF(TRIM(override_reason), '') IS NOT NULL AND overridden_by IS NOT NULL AND overridden_at IS NOT NULL)
  )
);

CREATE TABLE coordinator_schedule_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES schedule_batches(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  schedule_type VARCHAR(30) NOT NULL CHECK (schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY')),
  priority_group_id UUID NOT NULL REFERENCES priority_groups(id),
  target_date DATE,
  target_week_start DATE,
  target_week_end DATE,
  remarks TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VALID', 'WARNING', 'CONFLICT', 'SCHEDULED', 'UNSCHEDULED')),
  validation_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT schedule_item_target_choice CHECK (
    (target_date IS NOT NULL AND target_week_start IS NULL AND target_week_end IS NULL)
    OR (target_date IS NULL AND target_week_start IS NOT NULL AND target_week_end IS NOT NULL)
  ),
  CONSTRAINT schedule_item_week_order CHECK (
    target_week_start IS NULL OR target_week_end >= target_week_start
  ),
  UNIQUE (batch_id, student_number, schedule_type)
);

CREATE INDEX students_name_search_idx ON students (last_name, first_name);
CREATE INDEX students_reference_idx ON students (college_id, program_id, year_level);
CREATE INDEX batches_status_idx ON schedule_batches (clinic_id, status, created_at DESC);
CREATE INDEX schedule_items_batch_idx ON coordinator_schedule_items (batch_id, clinic_id, status);

CREATE TRIGGER students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER batches_updated_at BEFORE UPDATE ON schedule_batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER schedule_items_updated_at BEFORE UPDATE ON coordinator_schedule_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
