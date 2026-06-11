CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('ADMIN', 'CLINIC_STAFF')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_email_normalized CHECK (email = LOWER(email))
);
CREATE UNIQUE INDEX users_email_unique ON users (LOWER(email));

CREATE TABLE colleges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(150) UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES colleges(id),
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (college_id, code),
  UNIQUE (college_id, name),
  UNIQUE (id, college_id)
);

CREATE TABLE priority_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) UNIQUE NOT NULL,
  rank_order INTEGER UNIQUE NOT NULL CHECK (rank_order > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE clinic_capacity_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_type VARCHAR(30) UNIQUE NOT NULL CHECK (schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY')),
  safe_daily_capacity INTEGER NOT NULL DEFAULT 120 CHECK (safe_daily_capacity > 0),
  max_daily_capacity INTEGER NOT NULL DEFAULT 150,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (max_daily_capacity >= safe_daily_capacity)
);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER colleges_updated_at BEFORE UPDATE ON colleges FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER programs_updated_at BEFORE UPDATE ON programs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER priority_groups_updated_at BEFORE UPDATE ON priority_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER capacity_updated_at BEFORE UPDATE ON clinic_capacity_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
