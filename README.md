# MedClinic Scheduler

Student master-data and grouped physical examination/laboratory scheduling for Central Philippine University Health Services.

## MVP Capabilities

- JWT login for administrators and clinic staff
- Student, college, program, priority group, user, and capacity management
- Unified Students & Schedules workspace with manual student management for all staff
- Administrator-only master CSV imports with missing-student creation and row/column validation
- One grouped import operation for the laboratory and physical examination child schedules
- Missing-data, enrollment, active-appointment, and daily-capacity validation
- Deterministic weekday distribution ordered by priority and student number
- Atomic grouped validation, generation, and publication
- Draft review only inside administrator import detail
- Published-only clinic/global schedules, status history, and replacement-based rescheduling
- Public lookup and result/compliance views that expose published appointment data only
- Physical examination and laboratory result history
- Compliance filters and live dashboard metrics
- Raw PostgreSQL migrations, reference-data seeds, narrow demo cleanup, and audit logs

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

4. Apply schema and reference data:

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

The seed creates clinics, users, colleges, programs, priority groups, and capacity settings. It does not create students, appointments, imports, or coordinator batches.

## Master Schedule CSV Format

Use UTF-8 CSV files with these headers in this exact order:

```csv
Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule
23-1212-97,"Abad, Aaron Miguel A.",College of Computer Studies,BSIT,3,07-29-2026,07-30-2026
```

- Download the safe sample at [`public/templates/student-schedule-import-template.csv`](public/templates/student-schedule-import-template.csv).
- `Name` must use `Last, First Middle` form and must be CSV-quoted because it contains a comma. The example is stored as first name `Aaron`, middle name `Miguel A.`, and last name `Abad`.
- Both schedule columns use `MM-DD-YYYY`.
- Either schedule date may be blank, but every row must contain at least one of them. A row with both dates creates one request for each clinic.
- Files may contain up to 500 data rows and may not exceed 1 MB.
- Student IDs must be unique within the file; repeated IDs are rejected case-insensitively after Unicode normalization.
- An administrator chooses one active priority group for the entire import.
- College names and course codes must match active reference data. Matching is case-insensitive.
- Missing students are created from the parsed CSV name, college, course, and year.
- Existing students are never overwritten. A name, college, course, or year mismatch rejects the entire file with row-specific errors.
- The import is atomic: a failed row leaves no partial students, import group, or clinic batches.
- A successful CSV appears as one grouped import with laboratory and/or physical examination child sections. Validate, Generate, and Publish each run atomically across every child.
- Generated appointments remain private in the administrator import detail until the entire group is published.

## Database Commands

```powershell
npm run db:migrate
npm run db:seed
```

Migration `006_unified_student_schedule_imports.sql` adds grouped imports and removes only known development fixtures: students whose number begins `DEMO-`, five fixed demo batch IDs, and their dependent appointments/results/audits. It does not delete other student records. The reference-data seed is idempotent and does not recreate demo students or batches.

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

Tests cover CSV/name parsing, grouped transaction rollback, atomic lifecycle actions, authorization, draft privacy across every normal reader, published clinic schedules, legacy redirects, rescheduling, result history, compliance, and critical client interactions.

## Demonstration Flow

1. Sign in as administrator and open **Students & Schedules**.
2. Confirm the Students view has no `DEMO-` records, then open **Schedule Imports**.
3. Upload the official seven-column CSV, choose a priority, and open its grouped detail.
4. Confirm the laboratory and physical examination item counts and dates, then validate the whole import.
5. Review row issues and capacity conflicts. A capacity override requires an administrator reason.
6. Generate the grouped appointments and confirm they remain absent from Laboratory, Physical Exam, global appointments, compliance, results, and public lookup.
7. Publish the complete import, then verify its appointments in `/laboratory` and `/physical-exam`.
8. Search several student numbers and compare both published dates with the source CSV.
9. Sign in as clinic staff. Confirm the master import tab/control is unavailable while manual student management and permitted appointment/result work remain available.
10. Update a published appointment or create a linked replacement, encode results, and review `/compliance` and the dashboard.

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
- Only administrators can list, inspect, create, validate, generate, or publish grouped schedule imports.
- Students do not authenticate. The public lookup omits notes, audit logs, unpublished appointments, and results linked to unpublished appointments.

## Local Network Deployment

Build and serve the production application:

```powershell
npm run build
npm start -- --hostname 0.0.0.0
```

Set `APP_URL` to the server's HTTPS URL when TLS is available. Restrict PostgreSQL access to the application host and do not expose port 5432 publicly.
