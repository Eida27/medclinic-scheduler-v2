# MedClinic Scheduler

Student master-data and grouped physical examination/laboratory scheduling for Central Philippine University Health Services.

## MVP Capabilities

- JWT login for administrators, global coordinators, and clinic staff
- Student, college, program, priority group, user, and capacity management
- Unified Students & Schedules workspace with manual student management for administrators and clinic staff, plus read-only coordinator access
- Administrator and coordinator master CSV imports with missing-student creation and row/column validation
- One-confirmation import, validation, appointment generation, and publication for laboratory and physical examination schedules
- Missing-data, enrollment, active-appointment, and daily-capacity validation
- Deterministic weekday distribution ordered by priority and student number
- Atomic grouped validation, generation, and publication with safe administrator-review checkpoints
- Draft review only inside the protected import detail
- Published-only clinic/global schedules, status history, and replacement-based rescheduling
- Public lookup and result views that expose published appointment data only
- Physical examination and laboratory result history
- Combined appointment/completion filters, student summaries, and live dashboard metrics
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
| Coordinator | `coordinator@medclinic.local` | `Coordinator123!` |
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
- Files may contain up to 3,000 data rows and may not exceed 1 MB.
- Student IDs must be unique within the file; repeated IDs are rejected case-insensitively after Unicode normalization.
- An administrator or coordinator chooses one active priority group for the entire import.
- College names and course codes must match active reference data. Matching is case-insensitive.
- Missing students are created from the parsed CSV name, college, course, and year.
- Existing students are never overwritten. A name, college, course, or year mismatch rejects the entire file with row-specific errors.
- The import is atomic: a failed row leaves no partial students, import group, or clinic batches.
- Selecting **Review import** opens one confirmation with the filename, priority, and publication impact. **Agree and import** sends one request that imports, validates, generates, and publishes atomically across every child stage.
- Invalid CSV or metadata creates nothing. A later processing failure saves a review checkpoint without exposing draft or generated appointments.
- Capacity conflicts stop at `VALIDATED`; only an administrator can enter an override reason and resume. Other recovery actions also remain administrator-only.
- Generated appointments remain private in the protected import detail until the entire group is published.

## Database Commands

```powershell
npm run db:migrate
npm run db:seed
```

Migration `006_unified_student_schedule_imports.sql` adds grouped imports and removes only known development fixtures: students whose number begins `DEMO-`, five fixed demo batch IDs, and their dependent appointments/results/audits. Migration `007_coordinator_import_automation.sql` adds the global coordinator role used by the automatic importer. The reference-data seed is idempotent and does not recreate demo students or batches.

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

1. Sign in as administrator or coordinator and open **Students & Schedules** → **Schedule Imports**.
2. Upload the official seven-column CSV, choose a priority, and select **Review import**.
3. Check the filename, priority, and publication impact in **Import and publish this CSV?**, then select **Agree and import**.
4. Confirm a conflict-free file opens as `PUBLISHED` with the expected student and appointment counts.
5. For a capacity conflict, confirm the import stops at `VALIDATED` and the coordinator sees an administrator-review notice. Sign in as administrator to enter an override reason and resume.
6. Search several student numbers and compare both published dates with the source CSV.
7. Sign in as coordinator. Confirm student records and import history are readable, while student editing, clinic operations, settings, and lifecycle controls are unavailable.
8. Sign in as clinic staff. Confirm the import tab is unavailable while permitted student, appointment, and result work remains available.
9. Update a published appointment or create a linked replacement, encode results, and review **Appointments & Completion** and the dashboard.

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
- Administrators and global coordinators can list, inspect, and start automatic grouped imports. Only administrators can call manual validate, generate, and publish actions or approve capacity overrides.
- Coordinators have no clinic assignment and receive read-only student access; they cannot manage users, reference data, capacity, individual students, or clinic operations.
- Students do not authenticate. The public lookup omits notes, audit logs, unpublished appointments, and results linked to unpublished appointments.

## Local Network Deployment

### Automatic no-show reconciliation

- The application checks overdue published appointments when the server starts and every five minutes while it remains running.
- Timed appointments become no-show 24 hours after their scheduled time in `APP_TIMEZONE`.
- Date-only appointments receive the full scheduled day plus the following 24 hours; a July 10 appointment becomes eligible at July 12, 12:00 AM.
- Completing a linked result also completes its appointment.
- Administrators and assigned clinic staff can correct a system-generated no-show with a required reason; manual no-shows cannot be corrected to completed.
- Downtime does not lose transitions: the startup sweep catches up when the server returns.

Build and serve the production application:

```powershell
npm run build
npm start -- --hostname 0.0.0.0
```

Set `APP_URL` to the server's HTTPS URL when TLS is available. Restrict PostgreSQL access to the application host and do not expose port 5432 publicly.
