# MedClinic Scheduler

Coordinator-driven physical examination and laboratory scheduling for Central Philippine University Health Services.

## MVP Capabilities

- JWT login for administrators and clinic staff
- Student, college, program, priority group, user, and capacity management
- Manual coordinator schedule batch encoding
- Atomic coordinator CSV import with missing-student creation and row-level validation
- Missing-data, enrollment, active-appointment, and daily-capacity validation
- Deterministic weekday distribution ordered by priority and student number
- Independent physical examination and laboratory appointments for `BOTH` requests
- Draft review, admin publishing, status history, and replacement-based rescheduling
- Public lookup that exposes published appointments only
- Physical examination and laboratory result history
- Compliance filters and live dashboard metrics
- Raw PostgreSQL migrations, deterministic demo data, and audit logs

Doctor scheduling, notifications, holidays, QR check-in, and student self-rescheduling are intentionally outside this MVP.

## Requirements

- Node.js 20 or later
- PostgreSQL 15 or later with permission to create the `pgcrypto` extension
- npm

## Local Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create the database:

   ```powershell
   createdb -U postgres medclinic_scheduler
   ```

3. Create `.env.local` from `.env.example` and replace the database password and JWT secret:

   ```env
   DATABASE_URL=postgresql://postgres:your-password@localhost:5432/medclinic_scheduler
   APP_URL=http://localhost:3000
   JWT_SECRET=replace-with-at-least-32-random-characters
   APP_TIMEZONE=Asia/Manila
   ```

4. Apply schema and demo data:

   ```powershell
   npm run db:migrate
   npm run db:seed
   ```

5. Start the application:

   ```powershell
   npm run dev
   ```

Open `http://localhost:3000`.

## Demo Accounts

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@medclinic.local` | `Admin123!` |
| Clinic staff | `staff@medclinic.local` | `Staff123!` |

Change these passwords before any real deployment.

## Demo Fixtures

The seed includes 180 students and four coordinator batches:

- `Demo Valid Capacity - 120`
- `Demo Warning Capacity - 130`
- `Demo Conflict Capacity - 160`
- `Demo Week Distribution`

Students use identifiers `DEMO-0001` through `DEMO-0180`.

## Coordinator CSV Format

Use UTF-8 CSV files with these headers in this exact order:

```csv
Student ID,Name,College,Course,Year,Appointment Date,Appointment Type
23-1212-97,Juan Dela Cruz,College of Computer Studies,BSIT,3,06-19-2026,Physical + Laboratory
```

- `Appointment Date` uses `MM-DD-YYYY`.
- `Appointment Type` accepts `Physical Examination`, `Laboratory`, or `Physical + Laboratory`.
- Files may contain up to 500 data rows and may not exceed 1 MB.
- Staff choose one active priority group for the entire upload.
- College names and course codes must match active reference data. Matching is case-insensitive.
- Missing students are created from the CSV. For new records, the first word of `Name` is stored as the first name and the remainder as the last name.
- Existing students are never overwritten. A name, college, course, or year mismatch rejects the entire file with row-specific errors.
- Successful imports create a draft batch. Staff still validate, generate, and publish it through the normal workflow.

## Database Commands

```powershell
npm run db:migrate
npm run db:seed
```

Reset is deliberately guarded and destroys all data in the configured database:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
```

The reset command refuses to operate on `postgres`, `template0`, or `template1`.

## Verification

```powershell
npm test
npm run lint
npm run build
```

Tests cover rule-engine boundaries, priority distribution, database constraints and rollback, authentication, batch validation and generation, draft privacy, publishing, rescheduling, result history, compliance, and critical client interactions.

## Demonstration Flow

1. Sign in as clinic staff and review or add students.
2. Import the official coordinator CSV or manually create a batch with an exact date or Monday-Friday target range.
3. Validate the batch and review per-item warnings or conflicts.
4. Generate draft appointments. Capacity conflicts require an administrator and an override reason.
5. Sign in as administrator and publish the generated batch.
6. Use `/student-lookup` to retrieve the published student schedule.
7. Update appointment status or create a linked replacement appointment.
8. Encode physical examination and laboratory results.
9. Review `/compliance` and the live dashboard metrics.

## Architecture

```text
App Router pages and client components
  -> Next.js route handlers
  -> services and validation
  -> repositories and transactions
  -> PostgreSQL
```

The pure scheduling rules live under `src/server/rule-engine`. Route handlers do not contain SQL, and UI components do not access PostgreSQL directly.

## Security Notes

- Session cookies are HTTP-only and same-site, with an eight-hour JWT lifetime.
- The secure cookie flag is enabled when the production `APP_URL` uses HTTPS.
- Protected pages pass through `src/proxy.ts` and are re-authorized against the active database user in the dashboard layout and service layer.
- SQL queries use parameters. Multi-table writes use one checked-out PostgreSQL client and explicit transactions.
- Students do not authenticate. The public lookup omits notes, audit logs, and unpublished appointments.

## Local Network Deployment

Build and serve the production application:

```powershell
npm run build
npm start -- --hostname 0.0.0.0
```

Set `APP_URL` to the server's HTTPS URL when TLS is available. Restrict PostgreSQL access to the application host and do not expose port 5432 publicly.
