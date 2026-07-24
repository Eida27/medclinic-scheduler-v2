# MedClinic Scheduler

Academic-year Laboratory and Physical Examination scheduling, clinic operations, and private student result submission for Central Philippine University Health Services.

## Capabilities

- Separate JWT sessions for administrators, coordinators, clinic staff, and students
- Atomic academic-year student imports with deterministic, date-only Laboratory/PE pairs
- Regular FCFS scheduling plus OJT, Tour, and Specialized priority windows
- Maximum daily capacity as the sole scheduling ceiling across imports, displacement, and clinic closures
- Minimum Regular displacement for priority capacity, with linked history and student notifications
- Future clinic unavailable dates: CPU Clinic moves PE only; KABALAKA Clinic replaces the pair
- Administrator appointment locks that automatic moves cannot override
- Published clinic schedules, next-midnight automatic no-shows, corrections, filters, and server-side sorting
- Student schedules, notifications, optional verified email alerts, and private result uploads
- Administrator-only cross-student document/ZIP access and invalidation
- Raw PostgreSQL migrations, reference seeds, targeted test cleanup, and privacy-conscious audits

Doctor scheduling, QR check-in, student self-rescheduling, and cloud document storage are outside the current scope.

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

3. Create `.env.local` from `.env.example`. At minimum, set:

   ```env
   DATABASE_URL=postgresql://postgres:your-password@localhost:5432/medclinic_scheduler
   APP_URL=http://localhost:3000
   JWT_SECRET=replace-with-at-least-32-random-characters
   APP_TIMEZONE=Asia/Manila
   RESULT_UPLOAD_ROOT=.data/private-result-uploads
   ```

4. Apply schema and reference data:

   ```powershell
   npm run db:migrate
   npm run db:seed
   ```

5. Start the application and open `http://localhost:3000`:

   ```powershell
   npm run dev
   ```

## Demo Staff Accounts

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@medclinic.local` | `Admin123!` |
| Coordinator | `coordinator@medclinic.local` | `Coordinator123!` |
| KABALAKA clinic staff | `staff@medclinic.local` | `Staff123!` |

Change seeded passwords before real deployment. Students sign in separately with Student Number and Date of Birth; imported students receive the DOB from the CSV. Existing students whose DOB is null remain readable but cannot sign in until updated.

## Academic-Year Student CSV

The supplied workbook is a reference source. Export it as **CSV UTF-8** or Excel **CSV (Comma delimited)** / Windows-1252 before upload. The application does not accept XLSX or UTF-16 CSV. The original workbook is never modified.

Use these headers in this exact order:

```csv
Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth
23-1212-97,Abad,Aaron Miguel,A.,,College of Computer Studies,BSIT,3,08-04-2004
```

- Download the matching sample at [`public/templates/student-schedule-import-template.csv`](public/templates/student-schedule-import-template.csv).
- Date of Birth is required and uses strict `MM-DD-YYYY`.
- MI and Suffix may be blank. Names are displayed surname-first with only the first middle initial.
- College names and course codes must match active reference data case-insensitively.
- Files may contain up to 3,000 data rows and may not exceed 1 MB.
- Student IDs must be valid and unique within the file after normalization.
- Choose the student category and academic-year start. OJT, Tour, and Specialized imports also require a preferred month; Regular does not.
- One POST validates references, acquires the scheduling lock, assigns acceptance order, upserts students, skips same-cycle duplicates, displaces only eligible Regular pairs when needed, creates both clinic batches, and publishes atomically.
- A failed row or protected/capacity conflict rolls back the complete import. New uploads do not create manual review checkpoints.
- Historical manually saved imports keep their protected lifecycle actions for backward compatibility.

Scheduling is Monday–Friday in Manila. Laboratory always precedes PE. Regular scheduling begins at the later of the first weekday in August or the seven-Manila-calendar-day preparation boundary. Priority scheduling uses the selected academic-year month and the same preparation boundary.

## Clinic Calendar and Date-Only Appointments

Administrators manage future holidays, closures, maintenance, and staff-unavailable ranges under **Administration → Clinic calendar**.

- CPU Clinic blocks move only active PE appointments; the paired Laboratory date stays unchanged.
- KABALAKA Clinic blocks replace both active appointments as a new pair.
- Completed, manually locked, or result-protected appointments stop the operation with HTTP 409 and unresolved details. The block is not saved.
- Historical `RESCHEDULED` and `CANCELLED` rows remain visible but do not block later closure calculations.
- Appointments expose only a date. No time-slot field is accepted or displayed.

Automatic no-shows run at the next local midnight after the appointment date. The Node worker performs startup catch-up, schedules the next Manila midnight, and retries a failed sweep after five minutes. Manual no-show assignment is rejected.

## Student Portal and Notifications

Use **Student sign in** from the public landing page. Authentication uses a separate HTTP-only `medclinic_student_session` cookie. Five failed attempts for the same normalized Student Number/IP pair cause a 15-minute lock. Login errors do not reveal whether a student exists, is inactive, or lacks DOB.

Every student query is constrained to the session Student Number and revalidates the active student. The portal includes:

- Published date-only schedule and reschedule history
- Portal notifications with read state
- Optional email verification
- Laboratory and PE result drafts/downloads
- Logout

Schedule changes and result invalidations always create a portal notification in the business transaction. A verified email also creates an outbox item. Email configuration is optional; missing or failing SMTP never blocks schedules, portal notices, or uploads.

To enable delivery, set:

```env
SMTP_HOST=smtp.example.edu
SMTP_PORT=587
SMTP_USER=optional-user
SMTP_PASS=optional-password
SMTP_FROM=clinic@example.edu
```

Verification links use 32 random bytes, store only a SHA-256 token hash in the verification table, and expire after 30 minutes. A previous verified address remains active until its replacement is verified. The email worker polls every minute, uses `FOR UPDATE SKIP LOCKED`, retries up to ten attempts, and caps exponential delay at one hour.

## Private Result Documents

Completing an appointment creates the matching `PENDING_UPLOAD` result if none exists. Existing manually recorded result statuses are preserved. Only the completed service becomes uploadable.

- Allowed: PDF, JPG/JPEG, and PNG with matching extension, declared MIME, and file signature
- Maximum 20 MB per file, 10 files per submission, and 50 MB combined
- Drafts support add, remove, and resume; inactive drafts expire after seven days
- Final submission locks student mutation and completes the result using the Manila date with no staff encoder
- Students can download only their own finalized files
- Only administrators can list other students' submissions, download individual documents/ZIPs, or invalidate a submission
- Invalidation keeps the appointment completed, resets the result to `PENDING_UPLOAD`, revokes prior metadata access, notifies the student, and opens a replacement draft

Files are stored beneath `RESULT_UPLOAD_ROOT` using generated submission/file IDs, never original names. Temporary files are atomically promoted, SHA-256 checksums are verified on download, and deletion failures remain retryable. `.data/private-result-uploads` is ignored by Git. Restrict this directory to the operating-system account that runs the application; do not place it under a public/static directory or shared network folder. The current adapter is local storage only.

## Database Commands

```powershell
npm run db:migrate
npm run db:seed
```

Migrations 008 and 009 add academic-year ordering/cycles, displacement/closure metadata, student identity/notifications, private submission metadata, `PENDING_UPLOAD`, and the date-only appointment schema. Migration 010 normalizes the deprecated safe-capacity column to maximum capacity; application scheduling uses maximum capacity only. Migration 012 replaces the college/program catalog with the exact CPU workbook catalog and removes the legacy `Graduating` priority group.

Migration 012 is intentionally destructive when a database contains non-workbook reference data. Back up PostgreSQL and `RESULT_UPLOAD_ROOT`, stop the application and workers, and keep an exclusive maintenance window. Review the cleanup manifest first:

```powershell
npm run db:reference-catalog-cleanup -- plan
```

To remove affected students and whole affected atomic import groups, including their schedules, results, audit rows, and private result files, explicitly authorize cleanup and then verify its persisted status before migrating:

```powershell
$env:REFERENCE_CATALOG_CLEANUP_EXCLUSIVE_DATABASE="1"
$env:REFERENCE_CATALOG_CLEANUP_CONFIRM="DELETE_NON_WORKBOOK_REFERENCE_DATA"
npm run db:reference-catalog-cleanup -- apply
npm run db:reference-catalog-cleanup -- status
npm run db:migrate
```

If private-file removal fails after database deletion commits, correct the storage problem and rerun `apply`; the state file at `.data/reference-catalog-cleanup/state.json` resumes from file deletion without replaying database deletion. Migration 012 refuses to remove referenced noncanonical catalog rows until cleanup has completed.

Reset is destructive and deliberately guarded:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
```

The reset command refuses to operate on `postgres`, `template0`, or `template1`.

## Verification

```powershell
npm test -- --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000
npm run lint
npm run build
```

Tests cover schema/backfills, the exact nine-column CSV, 3,000-row atomic imports, scheduling windows/capacity/concurrency, displacement, closure rollback, manual locks, date-only no-shows, separate sessions/throttling, strict ownership, file signatures/limits, finalization, ZIP access, invalidation, cleanup, outbox retry, and the full cross-feature scenario.

### Clinic UX Browser acceptance fixture

The targeted fixture reads `C:\endless_refinement\microsoft_docs\Physical_Laboratory_Scheduling_Completed.csv` in place and requires its exact 23,834-byte length, SHA-256 `fa01469d107bd0401444b9f95f555ffaf68a4c116b4600af8142c15dca5d3c17`, UTF-8 BOM, and exactly 280 accepted rows. It never changes, copies, or commits that source file. Every fixture command requires a PostgreSQL `DATABASE_URL` on `localhost`, `127.0.0.1`, or `::1` and an explicit `CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE=1` opt-in. Set that flag only when `DATABASE_URL` names a local database dedicated exclusively to this acceptance run; it is intentionally not baked into the npm script. `prepare` creates an ignored Windows-1252 upload under `.data/browser-clinic-scheduler-ux/` with exactly one `Peña` value, records a credential-free database identity plus matching-student/reference/capacity baselines, and prints the absolute upload and state paths.

```powershell
$env:CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE = "1"
npm run acceptance:clinic-ux -- prepare
# Upload the printed CSV through the UI and wait for the published import page.
npm run acceptance:clinic-ux -- stage
npm run acceptance:clinic-ux -- status
# Perform the printed correction, filter, clinic-context, and calendar checks.
npm run acceptance:clinic-ux -- cleanup
Remove-Item Env:CLINIC_UX_ACCEPTANCE_EXCLUSIVE_DATABASE
```

The ignored state is `.data/browser-clinic-scheduler-ux/state.json`. `stage`, `status`, and `cleanup` compare the current credential-free database identity with the one persisted by `prepare` before connecting; a mismatch is refused so the operator can switch back to the original database. `stage` requires exactly one fully published 280-student import: two published service batches, 560 coordinator items, 560 published pending appointments, and 280 complete Laboratory/PE pairs. It fails before staging mutations if any count or status is partial, then prepares deterministic past correction, both-completed, mixed-result, clinic-context, successful-calendar, and protected-failure-calendar records. Before cleanup commits a database deletion, state persists the exact owned IDs plus every private storage key/directory. Retries resume by phase: database deletion/restoration runs once, file deletion resumes only from `DATABASE_DELETED`, and `FILES_DELETED` reruns proof only. Final proof queries every manifest ID directly, restores pre-existing student/program rows and both capacity columns, removes private/temp files only below `RESULT_UPLOAD_ROOT`, and requires zero residue in every reported category before removing state. Rows tied only to a pre-existing student's number are preserved; the manifest claims such activity only through exact import, appointment, submission, closure, result, or fixture-created-student provenance.

## Demonstration Flow

1. Sign in as coordinator and open **Students & Schedules → New academic-year import**.
2. Upload an exported nine-column CSV UTF-8 or Excel CSV (Comma delimited) / Windows-1252 file, choose category/year (and preferred month when required), and submit once.
3. Confirm the import is `PUBLISHED`, dates are date-only, Laboratory precedes PE, and overflow/displacement totals are visible.
4. Import a priority category against constrained capacity and review the Regular student's linked replacement history and notification.
5. As administrator, add CPU and KABALAKA unavailable dates and confirm their PE-only/pair rules.
6. As KABALAKA clinic staff, complete a Laboratory appointment.
7. Use **Student sign in** with that Student Number/DOB, upload multiple synthetic PDF/PNG files, finalize, and download them.
8. As administrator, open **Student result submissions**, download the file/ZIP, invalidate with a reason, and confirm the student sees a notification and reopened draft.
9. Confirm the Browser console is free of warnings/errors, then remove only the targeted synthetic fixtures and restore capacity settings.

## Architecture and Security

```text
App Router pages and client components
  -> Next.js route handlers
  -> services and validation
  -> repositories and explicit transactions
  -> PostgreSQL and private storage adapter
```

- Staff and student sessions use separate HTTP-only, same-site cookies with eight-hour JWT lifetimes.
- The secure flag is enabled when the production `APP_URL` uses HTTPS.
- Protected identities are re-authorized against active database records.
- SQL is parameterized; multi-table business changes use one checked-out client and explicit transactions.
- Coordinators can operate imports but cannot access medical documents or clinic/admin operations.
- Clinic staff are limited to their assigned clinic.
- Audit metadata records aggregate file counts/bytes and operational reasons, never file contents or DOB.
- Public lookup remains available but exposes only published schedule/compliance data.

For production:

```powershell
npm run build
npm start -- --hostname 0.0.0.0
```

Use HTTPS, set `APP_URL` accordingly, restrict PostgreSQL to the application host, and back up both PostgreSQL and the private upload root together.
