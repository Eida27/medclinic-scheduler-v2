# MedClinic Scheduler — Full Implementation Plan

Repository: `https://github.com/Eida27/medclinic-scheduler.git`

Project type: Capstone system for Central Philippine University physical examination and laboratory scheduling.

Primary goal: Build a coordinator-driven clinic scheduling and compliance tracking system. The system should organize, validate, publish, and track physical examination and laboratory schedules based on schedule data provided by academic coordinators.

---

## 1. Non-Negotiable Scope Decisions

Build the system according to these decisions first. Do not expand beyond this MVP unless the base system is already working.

### 1.1 System Direction

The system is not a fully automatic doctor/resource optimization scheduler in the first version.

The system is a coordinator-driven physical examination and laboratory scheduling management system with compliance tracking.

Main idea:

```txt
Coordinator provides student list + exact date/week + priority group
        ↓
Clinic staff imports or encodes the data
        ↓
System validates and organizes schedules
        ↓
Clinic staff reviews conflicts and capacity warnings
        ↓
Clinic admin publishes schedule
        ↓
Students view assigned schedule
        ↓
Clinic staff tracks appointment status and compliance
```

### 1.2 Excluded From MVP

Do not implement these in the initial version:

- Doctor availability management
- Doctor-to-student assignment
- Doctor schedule calendar
- Automatic doctor optimization
- AI-based scheduling
- SMS/email notifications
- QR code check-in
- Complex analytics
- Student self-rescheduling
- Multi-campus support

### 1.3 Included in MVP

Implement these:

- User login and role-based access
- Student management
- College and program management
- Priority group management
- Coordinator-provided schedule batches
- Manual encoding of coordinator schedules
- Optional CSV import if time allows
- Schedule validation
- Rule-based appointment generation
- Daily capacity checking
- Appointment review and publishing
- Student public schedule lookup
- Appointment status tracking
- Physical examination and laboratory compliance tracking
- Previous physical examination/laboratory record lookup
- Basic reports and filters

---

## 2. Technology Stack

Use this stack:

- Frontend: Next.js App Router with TypeScript
- Backend: Next.js Route Handlers under `src/app/api`
- Database: PostgreSQL
- Database access: `pg` / node-postgres
- Schema management: raw `.sql` migration and seed files
- Styling: Tailwind CSS if already configured; otherwise plain CSS modules or global CSS is acceptable
- Deployment target: local network server

Do not use Prisma, Drizzle, Sequelize, Supabase, Firebase, MongoDB, or external backend frameworks for the MVP.

---

## 3. Architecture Style

Use a layered architecture:

```txt
Frontend Pages
    ↓
Reusable Components
    ↓
API Route Handlers
    ↓
Service Layer
    ↓
Rule Engine / Business Logic
    ↓
Repository Layer
    ↓
PostgreSQL Database
```

Rules:

- UI components must not query PostgreSQL directly.
- API route handlers must stay thin.
- Business logic must live in services and the rule engine.
- SQL queries must live in repository files.
- Rule-based scheduling logic must live in a dedicated server-only rule engine folder.

---

## 4. Recommended Folder Structure

Create or refactor the project into this structure:

```txt
medclinic-scheduler/
├── database/
│   ├── migrations/
│   │   ├── 001_create_users.sql
│   │   ├── 002_create_colleges.sql
│   │   ├── 003_create_programs.sql
│   │   ├── 004_create_students.sql
│   │   ├── 005_create_priority_groups.sql
│   │   ├── 006_create_clinic_capacity_settings.sql
│   │   ├── 007_create_schedule_batches.sql
│   │   ├── 008_create_coordinator_schedule_items.sql
│   │   ├── 009_create_appointments.sql
│   │   ├── 010_create_appointment_status_logs.sql
│   │   ├── 011_create_exam_results.sql
│   │   ├── 012_create_laboratory_results.sql
│   │   └── 013_create_audit_logs.sql
│   │
│   ├── seeds/
│   │   ├── seed_users.sql
│   │   ├── seed_colleges.sql
│   │   ├── seed_programs.sql
│   │   ├── seed_priority_groups.sql
│   │   └── seed_capacity_settings.sql
│   │
│   └── README.md
│
├── public/
│   ├── images/
│   └── logos/
│
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   │
│   │   ├── (public)/
│   │   │   ├── login/
│   │   │   │   └── page.tsx
│   │   │   └── student-lookup/
│   │   │       └── page.tsx
│   │   │
│   │   ├── (dashboard)/
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx
│   │   │   ├── students/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── new/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── [studentNumber]/
│   │   │   │       └── page.tsx
│   │   │   ├── coordinator-schedules/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── new/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── [batchId]/
│   │   │   │       └── page.tsx
│   │   │   ├── appointments/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [appointmentId]/
│   │   │   │       └── page.tsx
│   │   │   ├── compliance/
│   │   │   │   └── page.tsx
│   │   │   ├── results/
│   │   │   │   └── page.tsx
│   │   │   └── settings/
│   │   │       ├── capacity/
│   │   │       │   └── page.tsx
│   │   │       ├── users/
│   │   │       │   └── page.tsx
│   │   │       └── reference-data/
│   │   │           └── page.tsx
│   │   │
│   │   └── api/
│   │       ├── auth/
│   │       │   ├── login/
│   │       │   │   └── route.ts
│   │       │   └── logout/
│   │       │       └── route.ts
│   │       ├── students/
│   │       │   ├── route.ts
│   │       │   └── [studentNumber]/
│   │       │       └── route.ts
│   │       ├── coordinator-schedules/
│   │       │   ├── route.ts
│   │       │   ├── validate/
│   │       │   │   └── route.ts
│   │       │   └── [batchId]/
│   │       │       └── route.ts
│   │       ├── appointments/
│   │       │   ├── route.ts
│   │       │   ├── generate/
│   │       │   │   └── route.ts
│   │       │   ├── publish/
│   │       │   │   └── route.ts
│   │       │   └── [appointmentId]/
│   │       │       └── route.ts
│   │       ├── student-lookup/
│   │       │   └── route.ts
│   │       ├── compliance/
│   │       │   └── route.ts
│   │       ├── results/
│   │       │   └── route.ts
│   │       └── settings/
│   │           ├── capacity/
│   │           │   └── route.ts
│   │           └── reference-data/
│   │               └── route.ts
│   │
│   ├── components/
│   │   ├── ui/
│   │   │   ├── Button.tsx
│   │   │   ├── Input.tsx
│   │   │   ├── Select.tsx
│   │   │   ├── Textarea.tsx
│   │   │   ├── Table.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── Badge.tsx
│   │   │   ├── Card.tsx
│   │   │   └── Alert.tsx
│   │   ├── layout/
│   │   │   ├── DashboardShell.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Header.tsx
│   │   ├── students/
│   │   │   ├── StudentForm.tsx
│   │   │   ├── StudentTable.tsx
│   │   │   └── StudentStatusBadge.tsx
│   │   ├── schedules/
│   │   │   ├── ScheduleBatchForm.tsx
│   │   │   ├── ScheduleItemTable.tsx
│   │   │   ├── ScheduleValidationPanel.tsx
│   │   │   └── ScheduleBatchStatusBadge.tsx
│   │   ├── appointments/
│   │   │   ├── AppointmentTable.tsx
│   │   │   ├── AppointmentStatusBadge.tsx
│   │   │   └── RescheduleDialog.tsx
│   │   └── compliance/
│   │       ├── ComplianceFilters.tsx
│   │       ├── ComplianceSummaryCards.tsx
│   │       └── ComplianceTable.tsx
│   │
│   ├── server/
│   │   ├── db/
│   │   │   └── pool.ts
│   │   ├── repositories/
│   │   │   ├── users.repository.ts
│   │   │   ├── students.repository.ts
│   │   │   ├── reference-data.repository.ts
│   │   │   ├── coordinator-schedules.repository.ts
│   │   │   ├── appointments.repository.ts
│   │   │   ├── compliance.repository.ts
│   │   │   ├── results.repository.ts
│   │   │   └── settings.repository.ts
│   │   ├── services/
│   │   │   ├── auth.service.ts
│   │   │   ├── students.service.ts
│   │   │   ├── coordinator-schedules.service.ts
│   │   │   ├── appointments.service.ts
│   │   │   ├── compliance.service.ts
│   │   │   ├── results.service.ts
│   │   │   └── settings.service.ts
│   │   └── rule-engine/
│   │       ├── index.ts
│   │       ├── types.ts
│   │       ├── capacity-rules.ts
│   │       ├── priority-rules.ts
│   │       ├── date-distribution-rules.ts
│   │       ├── conflict-rules.ts
│   │       ├── compliance-rules.ts
│   │       └── generate-schedule.ts
│   │
│   ├── lib/
│   │   ├── api-response.ts
│   │   ├── errors.ts
│   │   ├── dates.ts
│   │   ├── validation.ts
│   │   └── constants.ts
│   │
│   ├── types/
│   │   ├── common.ts
│   │   ├── roles.ts
│   │   ├── schedule.ts
│   │   └── database.ts
│   │
│   └── middleware.ts
│
├── .env.example
├── next.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

## 5. Roles and Permissions

Create these user roles:

```txt
ADMIN
CLINIC_STAFF
```

Future role, optional after MVP:

```txt
COORDINATOR
```

Students do not need login for MVP. They can use public schedule lookup by student number.

### 5.1 Admin Permissions

Admin can:

- Manage clinic users
- Manage capacity settings
- Manage colleges/programs/priority groups
- View all schedules
- Generate appointments
- Publish schedules
- Override capacity conflicts if needed
- View reports

### 5.2 Clinic Staff Permissions

Clinic staff can:

- Manage students
- Encode/import coordinator schedule data
- Validate schedules
- Generate appointment drafts
- Update appointment statuses
- Reschedule students
- View compliance and results

Clinic staff cannot:

- Manage users
- Change capacity rules without admin approval
- Override maximum capacity without admin approval

---

## 6. Core Database Design

Use PostgreSQL with raw SQL migration files.

Prefer `student_number` as the public/business identifier. It may also be used as the primary key for the `students` table if the school treats it as permanent. Use `VARCHAR(20)` to support formats like `23-1212-97`.

### 6.1 `users`

Purpose: clinic/admin authentication.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
full_name VARCHAR(150) NOT NULL
email VARCHAR(150) UNIQUE NOT NULL
password_hash TEXT NOT NULL
role VARCHAR(30) NOT NULL CHECK (role IN ('ADMIN', 'CLINIC_STAFF'))
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### 6.2 `colleges`

Purpose: store colleges such as Engineering, Nursing, Computer Studies.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
code VARCHAR(30) UNIQUE NOT NULL
name VARCHAR(150) UNIQUE NOT NULL
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### 6.3 `programs`

Purpose: store programs under colleges.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
college_id UUID NOT NULL REFERENCES colleges(id)
code VARCHAR(30) NOT NULL
name VARCHAR(150) NOT NULL
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
UNIQUE (college_id, code)
UNIQUE (college_id, name)
```

### 6.4 `students`

Purpose: master list of students.

Columns:

```txt
student_number VARCHAR(20) PRIMARY KEY
first_name VARCHAR(100) NOT NULL
middle_name VARCHAR(100)
last_name VARCHAR(100) NOT NULL
suffix VARCHAR(20)
college_id UUID NOT NULL REFERENCES colleges(id)
program_id UUID NOT NULL REFERENCES programs(id)
year_level INTEGER CHECK (year_level BETWEEN 1 AND 6)
section VARCHAR(50)
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### 6.5 `priority_groups`

Purpose: coordinator-provided prioritization categories.

Default values:

```txt
Graduating
OJT
Tour
Regular
```

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
name VARCHAR(80) UNIQUE NOT NULL
rank_order INTEGER UNIQUE NOT NULL
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

Lower `rank_order` means higher priority.

Example:

```txt
Graduating = 1
OJT = 2
Tour = 3
Regular = 4
```

### 6.6 `clinic_capacity_settings`

Purpose: configurable daily capacity rules.

Important rule from adviser:

```txt
Recommended daily capacity: 120 students
Maximum daily capacity: 150 students
```

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
schedule_type VARCHAR(30) NOT NULL CHECK (schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY', 'BOTH'))
safe_daily_capacity INTEGER NOT NULL DEFAULT 120
max_daily_capacity INTEGER NOT NULL DEFAULT 150
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
CHECK (safe_daily_capacity > 0)
CHECK (max_daily_capacity >= safe_daily_capacity)
UNIQUE (schedule_type, is_active)
```

### 6.7 `schedule_batches`

Purpose: group coordinator schedule submissions.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
batch_name VARCHAR(150) NOT NULL
college_id UUID REFERENCES colleges(id)
program_id UUID REFERENCES programs(id)
submitted_by_name VARCHAR(150)
description TEXT
status VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
  CHECK (status IN ('DRAFT', 'VALIDATED', 'GENERATED', 'PUBLISHED', 'CANCELLED'))
created_by UUID REFERENCES users(id)
published_by UUID REFERENCES users(id)
published_at TIMESTAMP
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### 6.8 `coordinator_schedule_items`

Purpose: each student schedule request from coordinator data.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
batch_id UUID NOT NULL REFERENCES schedule_batches(id) ON DELETE CASCADE
student_number VARCHAR(20) NOT NULL REFERENCES students(student_number)
schedule_type VARCHAR(30) NOT NULL CHECK (schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY', 'BOTH'))
priority_group_id UUID NOT NULL REFERENCES priority_groups(id)
target_date DATE
target_week_start DATE
target_week_end DATE
remarks TEXT
status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
  CHECK (status IN ('PENDING', 'VALID', 'WARNING', 'CONFLICT', 'SCHEDULED', 'UNSCHEDULED'))
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
CHECK (
  target_date IS NOT NULL
  OR (target_week_start IS NOT NULL AND target_week_end IS NOT NULL)
)
CHECK (
  target_week_start IS NULL
  OR target_week_end IS NULL
  OR target_week_end >= target_week_start
)
UNIQUE (batch_id, student_number, schedule_type)
```

### 6.9 `appointments`

Purpose: generated or manually created appointments.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
batch_id UUID REFERENCES schedule_batches(id)
schedule_item_id UUID REFERENCES coordinator_schedule_items(id)
student_number VARCHAR(20) NOT NULL REFERENCES students(student_number)
schedule_type VARCHAR(30) NOT NULL CHECK (schedule_type IN ('PHYSICAL_EXAM', 'LABORATORY', 'BOTH'))
appointment_date DATE NOT NULL
appointment_time TIME
status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
  CHECK (status IN ('DRAFT', 'PENDING', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED', 'CANCELLED'))
is_published BOOLEAN NOT NULL DEFAULT FALSE
rescheduled_from UUID REFERENCES appointments(id)
created_by UUID REFERENCES users(id)
updated_by UUID REFERENCES users(id)
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
UNIQUE (student_number, schedule_type, appointment_date)
```

Important behavior:

- Draft appointments are hidden from students.
- Published appointments are visible in public student lookup.
- A student should not have multiple active appointments for the same schedule type unless the old one is cancelled/rescheduled.

### 6.10 `appointment_status_logs`

Purpose: status history/audit trail for appointments.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE
old_status VARCHAR(30)
new_status VARCHAR(30) NOT NULL
notes TEXT
changed_by UUID REFERENCES users(id)
created_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### 6.11 `exam_results`

Purpose: physical examination result tracking and retrieval.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
student_number VARCHAR(20) NOT NULL REFERENCES students(student_number)
appointment_id UUID REFERENCES appointments(id)
result_status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
  CHECK (result_status IN ('PENDING', 'COMPLETED', 'REQUIRES_FOLLOW_UP', 'NOT_APPLICABLE'))
completed_at DATE
remarks TEXT
encoded_by UUID REFERENCES users(id)
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### 6.12 `laboratory_results`

Purpose: laboratory result tracking and retrieval.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
student_number VARCHAR(20) NOT NULL REFERENCES students(student_number)
appointment_id UUID REFERENCES appointments(id)
result_status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
  CHECK (result_status IN ('PENDING', 'COMPLETED', 'REQUIRES_FOLLOW_UP', 'NOT_APPLICABLE'))
completed_at DATE
remarks TEXT
encoded_by UUID REFERENCES users(id)
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### 6.13 `audit_logs`

Purpose: general audit trail for important actions.

Columns:

```txt
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
actor_user_id UUID REFERENCES users(id)
action VARCHAR(100) NOT NULL
entity_type VARCHAR(100) NOT NULL
entity_id VARCHAR(100)
metadata JSONB
created_at TIMESTAMP NOT NULL DEFAULT NOW()
```

---

## 7. Rule-Based Engine Design

Create the dedicated backend-only module:

```txt
src/server/rule-engine/
├── index.ts
├── types.ts
├── capacity-rules.ts
├── priority-rules.ts
├── date-distribution-rules.ts
├── conflict-rules.ts
├── compliance-rules.ts
└── generate-schedule.ts
```

Every file in `src/server` and `src/server/rule-engine` should start with:

```ts
import "server-only";
```

### 7.1 Capacity Rules

File:

```txt
src/server/rule-engine/capacity-rules.ts
```

Logic:

```txt
0–120 students in one day: valid
121–150 students in one day: warning
151+ students in one day: conflict / requires admin override
```

Return shape:

```ts
type CapacityCheckResult = {
  status: "valid" | "warning" | "conflict";
  date: string;
  count: number;
  safeCapacity: number;
  maxCapacity: number;
  message: string;
};
```

Example messages:

```txt
Valid: This date is within the recommended daily capacity.
Warning: This date has 138 scheduled students. This is above the recommended capacity of 120 but within the maximum capacity of 150.
Conflict: This date has 162 scheduled students, which exceeds the maximum daily capacity of 150.
```

### 7.2 Priority Rules

File:

```txt
src/server/rule-engine/priority-rules.ts
```

Logic:

Sort students by priority rank:

```txt
Graduating
OJT
Tour
Regular
```

The system should follow coordinator-provided priority groups. It should not invent priority categories.

### 7.3 Date Distribution Rules

File:

```txt
src/server/rule-engine/date-distribution-rules.ts
```

Rules:

```txt
If target_date exists:
    assign student to target_date

If target_week_start and target_week_end exist:
    distribute students across dates in that week
    respect priority order
    check daily capacity

If neither exact date nor week is valid:
    mark item as conflict
```

### 7.4 Conflict Rules

File:

```txt
src/server/rule-engine/conflict-rules.ts
```

Detect:

- Missing student number
- Student not found in master list
- Missing priority group
- Missing target date/week
- Invalid week range
- Duplicate schedule item in the same batch
- Student already has active appointment for same schedule type
- Daily capacity exceeded
- Batch already published

### 7.5 Compliance Rules

File:

```txt
src/server/rule-engine/compliance-rules.ts
```

Track:

- Pending physical examination
- Completed physical examination
- Pending laboratory
- Completed laboratory
- No-show
- Rescheduled
- Cancelled

### 7.6 Generate Schedule

File:

```txt
src/server/rule-engine/generate-schedule.ts
```

Purpose:

Generate appointment drafts from coordinator schedule items.

Input:

```ts
type GenerateScheduleInput = {
  batchId: string;
  items: CoordinatorScheduleItem[];
  capacitySettings: CapacitySetting[];
  existingAppointments: Appointment[];
};
```

Output:

```ts
type GenerateScheduleOutput = {
  appointmentsToCreate: DraftAppointment[];
  unscheduledItems: UnscheduledItem[];
  validationResults: ValidationIssue[];
  capacityResults: CapacityCheckResult[];
};
```

Important:

The rule engine should return data. It should not directly write to the database. The service layer should decide when to save generated appointments.

---

## 8. Backend API Contracts

All API responses should use a consistent shape.

Success:

```ts
{
  "ok": true,
  "data": {},
  "message": "Optional message"
}
```

Failure:

```ts
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

Create helper:

```txt
src/lib/api-response.ts
```

### 8.1 Auth

#### `POST /api/auth/login`

Body:

```json
{
  "email": "admin@example.com",
  "password": "password"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "user": {
      "id": "uuid",
      "fullName": "Clinic Admin",
      "email": "admin@example.com",
      "role": "ADMIN"
    }
  }
}
```

#### `POST /api/auth/logout`

Clears session/cookie.

### 8.2 Students

#### `GET /api/students`

Query filters:

```txt
search
collegeId
programId
yearLevel
isActive
page
limit
```

#### `POST /api/students`

Body:

```json
{
  "studentNumber": "23-1212-97",
  "firstName": "Juan",
  "middleName": "Santos",
  "lastName": "Dela Cruz",
  "collegeId": "uuid",
  "programId": "uuid",
  "yearLevel": 4,
  "section": "A"
}
```

Validation:

- Student number is required.
- Student number must be unique.
- First name and last name are required.
- College and program are required.

#### `GET /api/students/[studentNumber]`

Returns one student with appointments and compliance summary.

#### `PATCH /api/students/[studentNumber]`

Updates student information.

#### `DELETE /api/students/[studentNumber]`

Soft-delete only: set `is_active = false`.

### 8.3 Coordinator Schedules

#### `GET /api/coordinator-schedules`

Returns schedule batches.

#### `POST /api/coordinator-schedules`

Creates a batch with schedule items.

Body:

```json
{
  "batchName": "Engineering Graduating Students - June 2026",
  "collegeId": "uuid",
  "programId": "uuid",
  "submittedByName": "Coordinator Name",
  "description": "Graduating students for APE and laboratory",
  "items": [
    {
      "studentNumber": "23-1212-97",
      "scheduleType": "BOTH",
      "priorityGroupId": "uuid",
      "targetDate": "2026-07-01",
      "targetWeekStart": null,
      "targetWeekEnd": null,
      "remarks": "Graduating"
    }
  ]
}
```

#### `POST /api/coordinator-schedules/validate`

Validates batch data without generating appointments yet.

Body:

```json
{
  "batchId": "uuid"
}
```

Response should include:

```json
{
  "issues": [],
  "capacityResults": [],
  "summary": {
    "totalItems": 100,
    "validCount": 95,
    "warningCount": 3,
    "conflictCount": 2
  }
}
```

#### `GET /api/coordinator-schedules/[batchId]`

Returns batch details and items.

#### `PATCH /api/coordinator-schedules/[batchId]`

Updates draft batch metadata.

### 8.4 Appointments

#### `POST /api/appointments/generate`

Generates draft appointments from a schedule batch.

Body:

```json
{
  "batchId": "uuid"
}
```

Rules:

- Do not generate if batch has conflicts unless admin override is provided.
- Do not publish immediately.
- Generated appointments should be `DRAFT` and `is_published = false`.

#### `GET /api/appointments`

Filters:

```txt
appointmentDate
scheduleType
status
collegeId
programId
studentNumber
isPublished
page
limit
```

#### `PATCH /api/appointments/[appointmentId]`

Update appointment status or reschedule.

Allowed changes:

- appointment date
- appointment time
- status
- notes

When status changes, insert into `appointment_status_logs`.

#### `POST /api/appointments/publish`

Publishes all generated appointments for a batch.

Body:

```json
{
  "batchId": "uuid",
  "confirm": true
}
```

Rules:

- Only admin or authorized staff can publish.
- If any day exceeds 150 students, require admin override.
- Set `is_published = true`.
- Set appointment status from `DRAFT` to `PENDING`.
- Update batch status to `PUBLISHED`.

### 8.5 Student Lookup

#### `GET /api/student-lookup?studentNumber=23-1212-97`

Public endpoint.

Returns only safe student-facing details:

```json
{
  "studentNumber": "23-1212-97",
  "studentName": "Juan Dela Cruz",
  "appointments": [
    {
      "scheduleType": "BOTH",
      "appointmentDate": "2026-07-01",
      "appointmentTime": null,
      "status": "PENDING"
    }
  ],
  "compliance": {
    "physicalExam": "PENDING",
    "laboratory": "PENDING"
  }
}
```

Do not expose private staff notes or internal audit logs.

### 8.6 Compliance

#### `GET /api/compliance`

Filters:

```txt
collegeId
programId
priorityGroupId
physicalExamStatus
laboratoryStatus
appointmentStatus
search
page
limit
```

Response should include:

- summary cards
- filtered student list
- appointment status
- physical exam status
- laboratory status

### 8.7 Results

#### `GET /api/results?studentNumber=23-1212-97`

Returns previous physical examination and laboratory records for staff use.

#### `POST /api/results`

Encodes result status.

Body:

```json
{
  "studentNumber": "23-1212-97",
  "appointmentId": "uuid",
  "resultType": "PHYSICAL_EXAM",
  "resultStatus": "COMPLETED",
  "completedAt": "2026-07-01",
  "remarks": "Completed"
}
```

### 8.8 Settings

#### `GET /api/settings/capacity`

Returns capacity settings.

#### `PATCH /api/settings/capacity`

Admin only.

Body:

```json
{
  "scheduleType": "BOTH",
  "safeDailyCapacity": 120,
  "maxDailyCapacity": 150
}
```

---

## 9. Frontend Pages

### 9.1 `/login`

Purpose: clinic staff/admin login.

UI:

- Email input
- Password input
- Login button
- Error alert

### 9.2 `/student-lookup`

Purpose: public student schedule lookup.

UI:

- Student number input
- Search button
- Appointment card
- Compliance status
- Friendly empty state if no schedule found

Do not show internal notes.

### 9.3 `/dashboard`

Purpose: staff/admin overview.

Show cards:

- Total students
- Pending appointments
- Completed physical exams
- Completed laboratory records
- No-shows
- Rescheduled appointments
- Over-capacity warnings
- Unpublished schedule batches

### 9.4 `/students`

Purpose: manage students.

Features:

- Search by student number/name
- Filter by college/program/year level
- Add student
- Edit student
- Deactivate student
- View student details

### 9.5 `/coordinator-schedules`

Purpose: manage coordinator-provided schedule batches.

Features:

- List batches
- Create batch
- Add schedule items
- Validate batch
- View validation results
- Generate appointment draft

### 9.6 `/coordinator-schedules/new`

Purpose: encode coordinator schedule data.

Form fields:

- Batch name
- College
- Program
- Submitted by
- Description
- Schedule items table

Each schedule item:

- Student number
- Schedule type
- Priority group
- Exact target date OR target week start/end
- Remarks

### 9.7 `/coordinator-schedules/[batchId]`

Purpose: view batch details.

Show:

- Batch metadata
- Items table
- Validation panel
- Capacity warnings
- Generate appointments button
- Publish button if generated

### 9.8 `/appointments`

Purpose: review and manage appointments.

Features:

- Filter by date, status, type, college, program
- View appointment list
- Update status
- Reschedule
- Publish batch

### 9.9 `/appointments/[appointmentId]`

Purpose: appointment detail page.

Show:

- Student details
- Appointment date/time/type
- Status
- Status history
- Result status
- Reschedule form

### 9.10 `/compliance`

Purpose: monitor who complied and who has not.

Features:

- Summary cards
- Filter by college/program/priority/status
- Table of students
- Physical exam status
- Laboratory status
- Appointment status

### 9.11 `/results`

Purpose: retrieve previous physical examination and lab records.

Features:

- Search by student number
- View physical exam records
- View lab records
- Encode/update result status

### 9.12 `/settings/capacity`

Purpose: manage daily capacity.

Default settings:

```txt
PHYSICAL_EXAM: safe 120, max 150
LABORATORY: safe 120, max 150
BOTH: safe 120, max 150
```

Only admin can edit.

---

## 10. UI/UX Design Direction

Use a clean, school-clinic dashboard style.

Recommended layout:

```txt
Sidebar navigation
Top header
Main content cards
Tables with filters
Status badges
Validation alert panels
```

Use status badge colors consistently:

```txt
Pending: neutral/yellow
Completed: green
No-show: red
Rescheduled: blue/purple
Cancelled: gray
Warning: orange
Conflict: red
Draft: gray
Published: green
```

Important UX requirements:

- Every destructive action needs confirmation.
- Publishing schedule requires confirmation.
- Capacity conflicts must be very visible.
- Student lookup must be simple and mobile-friendly.
- Empty states must explain what the user should do next.

---

## 11. Implementation Phases

Build the system in this exact order.

### Phase 1 — Project Setup

Tasks:

- Ensure Next.js App Router + TypeScript is working.
- Install required dependencies.
- Set up `.env.example`.
- Set up PostgreSQL connection pool.
- Add base layout.
- Add reusable UI components.

Dependencies:

```bash
npm install pg bcryptjs jose
npm install -D @types/pg
```

Optional if not already installed:

```bash
npm install clsx
```

Create `.env.example`:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/medclinic_scheduler
APP_URL=http://localhost:3000
JWT_SECRET=replace-with-secure-secret
```

Acceptance checks:

- App runs with `npm run dev`.
- Database connection test works.
- Root page loads.

### Phase 2 — Database Migrations and Seeds

Tasks:

- Create all migration files in `database/migrations`.
- Create seed files in `database/seeds`.
- Add database README with instructions.
- Add scripts in `package.json` if possible.

Suggested scripts:

```json
{
  "scripts": {
    "db:migrate": "psql \"$DATABASE_URL\" -f database/migrations/001_create_users.sql",
    "db:seed": "psql \"$DATABASE_URL\" -f database/seeds/seed_users.sql"
  }
}
```

If cross-platform scripting becomes difficult on Windows, document manual `psql` commands instead.

Acceptance checks:

- Tables are created successfully.
- Seed data is inserted successfully.
- Unique and check constraints work.

### Phase 3 — Authentication and Layout

Tasks:

- Build login page.
- Implement login API.
- Hash passwords using `bcryptjs`.
- Store session using secure HTTP-only cookie with JWT.
- Implement middleware to protect dashboard routes.
- Build dashboard shell with sidebar/header.

Acceptance checks:

- Admin can login.
- Clinic staff can login.
- Unauthenticated users cannot access dashboard pages.
- Students can access `/student-lookup` without login.

### Phase 4 — Student Management

Tasks:

- Build students table migration and seed sample data.
- Build student repository.
- Build student service.
- Build `/api/students` endpoints.
- Build students page.
- Build add/edit student form.

Acceptance checks:

- Staff can create students.
- Duplicate student numbers are blocked.
- Staff can edit students.
- Staff can deactivate students.
- Students can be filtered by college/program/year level.

### Phase 5 — Reference Data Management

Tasks:

- Implement colleges, programs, priority groups, capacity settings.
- Build settings/reference-data page.
- Build settings/capacity page.

Acceptance checks:

- Admin can view reference data.
- Admin can edit capacity settings.
- Priority group rank order affects scheduling.

### Phase 6 — Coordinator Schedule Batches

Tasks:

- Build schedule batch tables.
- Build repository and service.
- Build `/api/coordinator-schedules` endpoints.
- Build schedule batch list page.
- Build create schedule batch page.
- Allow manual item encoding.

Acceptance checks:

- Staff can create a batch.
- Staff can add students to batch.
- Each item has schedule type, priority group, and target date/week.
- Duplicate student schedule items in the same batch are blocked.

### Phase 7 — Schedule Validation

Tasks:

- Build conflict rules.
- Build capacity rules.
- Build `/api/coordinator-schedules/validate`.
- Build validation results UI.

Validation checks:

- Missing student number
- Student not found
- Missing priority group
- Missing target date/week
- Invalid week range
- Duplicate schedule item
- Already scheduled student
- Over-capacity dates

Acceptance checks:

- Valid schedules show success.
- 121–150 students in one date shows warning.
- 151+ students in one date shows conflict.
- Conflicts are displayed clearly.

### Phase 8 — Rule-Based Appointment Generation

Tasks:

- Build rule engine.
- Implement priority sorting.
- Implement exact date assignment.
- Implement week-based distribution.
- Implement capacity checking.
- Build `/api/appointments/generate`.
- Save generated appointments as drafts.

Acceptance checks:

- Exact date items are assigned to exact date.
- Week-based items are distributed across the week.
- Priority order is respected.
- Draft appointments are created.
- Draft appointments are not visible to students.
- Unscheduled items are reported.

### Phase 9 — Appointment Review, Reschedule, and Publish

Tasks:

- Build appointments page.
- Build appointment detail page.
- Build update appointment endpoint.
- Build status update logging.
- Build publish endpoint.

Acceptance checks:

- Staff can view generated appointments.
- Staff can reschedule a student.
- Staff can mark status as completed/no-show/rescheduled/cancelled.
- Status changes create logs.
- Admin/staff can publish valid schedule batches.
- Published appointments are visible to students.

### Phase 10 — Student Lookup

Tasks:

- Build public student lookup page.
- Build `/api/student-lookup` endpoint.
- Return only published appointments.
- Return safe compliance summary.

Acceptance checks:

- Student can search by student number.
- Published schedule appears.
- Draft schedule does not appear.
- Unknown student shows friendly message.

### Phase 11 — Results and Compliance Tracking

Tasks:

- Build exam result and laboratory result repositories.
- Build results page.
- Build compliance page.
- Build result update API.
- Update compliance summary based on appointment/result status.

Acceptance checks:

- Staff can search previous records by student number.
- Staff can update physical exam result.
- Staff can update laboratory result.
- Compliance dashboard filters work.
- Pending/non-compliant students can be identified.

### Phase 12 — Polish, Testing, and Documentation

Tasks:

- Add loading states.
- Add empty states.
- Add error handling.
- Add confirmation modals.
- Add README setup instructions.
- Add sample data for demo.
- Test complete user flow.

Acceptance checks:

- End-to-end demo works from student creation to schedule publishing.
- No console errors.
- No broken pages.
- All forms validate inputs.
- All API errors return consistent response format.

---

## 12. Main User Flows to Test

### Flow 1 — Basic Successful Schedule

```txt
Admin logs in
Clinic staff adds students
Clinic staff creates coordinator schedule batch
Clinic staff validates batch
System shows no conflicts
Clinic staff generates appointments
Admin publishes schedule
Student searches student number
Student sees appointment
```

### Flow 2 — Capacity Warning

```txt
Coordinator schedule has 130 students on one day
System validates batch
System shows warning, not conflict
Staff can proceed after reviewing warning
```

### Flow 3 — Capacity Conflict

```txt
Coordinator schedule has 160 students on one day
System validates batch
System shows conflict
System prevents publishing unless admin override is implemented and confirmed
```

### Flow 4 — Missing Data

```txt
Schedule item has missing priority group
System marks item as conflict
System does not generate appointment for that item
```

### Flow 5 — Week-Based Distribution

```txt
Coordinator gives target week Monday-Friday
System distributes students across valid dates
System respects priority order
System checks daily capacity
```

### Flow 6 — Compliance Monitoring

```txt
Student appointment is completed
Staff encodes physical exam/lab result
Compliance dashboard updates completed count
Student no longer appears in pending list
```

---

## 13. Coding Guidelines

### 13.1 API Route Handlers

Keep route handlers thin.

Good:

```txt
route.ts
    ↓ calls service
service.ts
    ↓ applies business logic
repository.ts
    ↓ runs SQL
```

Bad:

```txt
route.ts contains validation + scheduling rules + SQL + response formatting
```

### 13.2 SQL

Use parameterized SQL queries only.

Good:

```ts
await pool.query(
  "SELECT * FROM students WHERE student_number = $1",
  [studentNumber]
);
```

Bad:

```ts
await pool.query(`SELECT * FROM students WHERE student_number = '${studentNumber}'`);
```

### 13.3 Data Validation

Validate at both levels:

- API/service validation for user-friendly errors
- PostgreSQL constraints for data integrity

### 13.4 Naming Conventions

Database:

```txt
snake_case
```

TypeScript:

```txt
camelCase
```

Example:

```txt
student_number in database
studentNumber in TypeScript/API response
```

### 13.5 Status Values

Use consistent uppercase values in database:

```txt
DRAFT
PENDING
COMPLETED
NO_SHOW
RESCHEDULED
CANCELLED
PUBLISHED
CONFLICT
WARNING
VALID
```

Convert to user-friendly text in the UI.

---

## 14. Important Business Rules Summary

### 14.1 Coordinator Data Rule

The coordinator-provided date/week and priority group are the source of truth.

The system should organize and validate the data, not ignore it.

### 14.2 Capacity Rule

```txt
0–120 = valid
121–150 = warning
151+ = conflict
```

Make these values configurable in `clinic_capacity_settings`.

### 14.3 Publishing Rule

Only published appointments are visible to students.

### 14.4 Doctor Availability Rule

Doctor availability is excluded from MVP.

Do not create doctor tables, doctor calendar pages, or doctor scheduling logic.

### 14.5 Compliance Rule

The system must help answer:

```txt
Who is scheduled?
Who completed physical examination?
Who completed laboratory?
Who has not complied yet?
Who needs rescheduling?
Which college/program has many pending students?
```

---

## 15. Suggested Demo Data

Seed these priority groups:

```txt
Graduating, rank 1
OJT, rank 2
Tour, rank 3
Regular, rank 4
```

Seed these capacity settings:

```txt
PHYSICAL_EXAM: safe 120, max 150
LABORATORY: safe 120, max 150
BOTH: safe 120, max 150
```

Seed sample colleges:

```txt
College of Engineering
College of Nursing
College of Computer Studies
```

Seed at least one admin:

```txt
full_name: System Admin
email: admin@medclinic.local
password: Admin123!
role: ADMIN
```

Seed at least one clinic staff:

```txt
full_name: Clinic Staff
email: staff@medclinic.local
password: Staff123!
role: CLINIC_STAFF
```

For demo students, create enough sample records to test:

- normal schedules
- duplicate detection
- 130-student warning case
- 160-student conflict case
- pending/completed/no-show statuses

---

## 16. Final Build Priority

Build in this order:

```txt
1. Project setup
2. Database migrations and seed data
3. Auth and protected dashboard shell
4. Student management
5. Reference data and capacity settings
6. Coordinator schedule batches
7. Schedule validation
8. Rule-based appointment generation
9. Appointment review and publishing
10. Student public lookup
11. Compliance tracking and results retrieval
12. Polish, testing, and documentation
```

Do not start with complex dashboards before the core scheduling flow works.

The most important complete path is:

```txt
Student records
    ↓
Coordinator schedule batch
    ↓
Validation
    ↓
Appointment generation
    ↓
Publishing
    ↓
Student lookup
    ↓
Compliance tracking
```

---

## 17. Definition of Done

The system is considered MVP-complete when:

- Admin and clinic staff can log in.
- Staff can manage students.
- Staff can create coordinator schedule batches.
- System validates missing data, duplicates, and capacity issues.
- System applies the 120–150 daily capacity rule.
- System generates draft appointments from coordinator data.
- Staff/admin can publish appointments.
- Students can search and view their published schedule.
- Staff can update appointment status.
- Staff can track physical examination and laboratory compliance.
- Staff can retrieve previous physical examination/laboratory records.
- The project has clear database migrations, seed files, and README setup instructions.

---

## 18. Notes for Codex

Implement the system from scratch using the repository structure above.

Follow the current scope strictly:

- Coordinator-driven schedule data
- Rule-based validation and appointment generation
- No doctor availability for MVP
- Daily clinic capacity of safe 120 and max 150 students
- PostgreSQL with raw SQL migrations
- Next.js App Router with API Route Handlers
- Dedicated server-side rule engine under `src/server/rule-engine`

Build one complete feature cycle at a time:

```txt
Plan feature
→ Design database
→ Build backend endpoint
→ Build frontend UI
→ Connect
→ Test
→ Repeat
```
