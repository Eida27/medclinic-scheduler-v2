CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES schedule_batches(id),
  schedule_item_id UUID REFERENCES coordinator_schedule_items(id),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  schedule_type VARCHAR(30) NOT NULL CHECK (schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY')),
  appointment_date DATE NOT NULL,
  appointment_time TIME,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED', 'CANCELLED')),
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  rescheduled_from UUID REFERENCES appointments(id),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, schedule_item_id, schedule_type),
  UNIQUE (rescheduled_from)
);

CREATE UNIQUE INDEX appointments_one_active_service_idx
  ON appointments (student_number, schedule_type)
  WHERE status IN ('DRAFT', 'PENDING');

CREATE TABLE appointment_status_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  old_status VARCHAR(30),
  new_status VARCHAR(30) NOT NULL,
  notes TEXT,
  changed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE exam_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  appointment_id UUID UNIQUE REFERENCES appointments(id),
  result_status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
    CHECK (result_status IN ('PENDING', 'COMPLETED', 'REQUIRES_FOLLOW_UP', 'NOT_APPLICABLE')),
  completed_at DATE,
  remarks TEXT,
  encoded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((result_status = 'COMPLETED' AND completed_at IS NOT NULL) OR result_status <> 'COMPLETED')
);

CREATE TABLE laboratory_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_number VARCHAR(20) NOT NULL REFERENCES students(student_number),
  appointment_id UUID UNIQUE REFERENCES appointments(id),
  result_status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
    CHECK (result_status IN ('PENDING', 'COMPLETED', 'REQUIRES_FOLLOW_UP', 'NOT_APPLICABLE')),
  completed_at DATE,
  remarks TEXT,
  encoded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((result_status = 'COMPLETED' AND completed_at IS NOT NULL) OR result_status <> 'COMPLETED')
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (LENGTH(TRIM(action)) > 0 AND LENGTH(TRIM(entity_type)) > 0)
);

CREATE INDEX appointments_date_service_idx ON appointments (appointment_date, schedule_type, status);
CREATE INDEX appointments_student_idx ON appointments (student_number, created_at DESC);
CREATE INDEX appointments_batch_idx ON appointments (batch_id, status);
CREATE INDEX status_logs_appointment_idx ON appointment_status_logs (appointment_id, created_at DESC);
CREATE INDEX exam_results_student_idx ON exam_results (student_number, completed_at DESC);
CREATE INDEX laboratory_results_student_idx ON laboratory_results (student_number, completed_at DESC);
CREATE INDEX audit_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);

CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER exam_results_updated_at BEFORE UPDATE ON exam_results FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER laboratory_results_updated_at BEFORE UPDATE ON laboratory_results FOR EACH ROW EXECUTE FUNCTION set_updated_at();
