# MedClinic Scheduler

Academic-year Laboratory and Physical Examination scheduling, clinic operations, and private student result submission for Central Philippine University Health Services.

See the [current policy index](docs/current-policies.md) before using historical design and implementation records as guidance.

## Capabilities

- Separate JWT sessions for administrators, coordinators, clinic staff, and students
- Atomic academic-year student imports with deterministic, date-only Laboratory/PE pairs
- Regular FCFS scheduling plus OJT, Tour, and First-Year/OVPSA scheduling
- Maximum daily capacity as the sole scheduling ceiling across imports, displacement, and clinic closures
- Minimum Regular displacement for OJT, Tour, and First-Year/OVPSA capacity, with linked history and student notifications
- Future clinic unavailable dates: CPU Clinic moves PE only; KABALAKA Clinic replaces the pair
- Administrator appointment locks that automatic moves cannot override
- Published clinic schedules, next-midnight automatic no-shows, corrections, filters, and server-side sorting
- Student schedules, mandatory email verification, notifications, and private result uploads
- Administrator-only cross-student document/ZIP access and invalidation
- Raw PostgreSQL migrations, reference seeds, targeted test cleanup, and privacy-conscious audits

Doctor scheduling, QR check-in, student self-rescheduling, and cloud document storage are outside the current scope.

## Requirements

- A maintained Node.js LTS release that satisfies Next.js's Node.js 20.9 minimum (Node.js 22 or 24 as of September 2026)
- PostgreSQL 15 or later with permission to create the `pgcrypto` extension
- npm

The current lockfile pins Next.js 16.3.5 and Sharp 0.35.4 while retaining React 19.2.4. Install this exact dependency tree with `npm ci` on the target operating system. Node.js 20 meets the framework's version floor but is end-of-life and should not be selected for a new production installation; follow the [Node.js release schedule](https://nodejs.org/en/about/previous-releases) and use an Active or Maintenance LTS release.

## First installation

Follow the complete [first-installation guide](docs/installation.md). It is the operator checklist for an empty database and has seven required steps:

1. Install a compatible Node.js and PostgreSQL runtime, then install the locked dependencies.
2. Configure the database, separate secrets, public URL, Manila timezone, durable private storage, and working SMTP; run `npm run install:preflight`.
3. Apply migrations and seed reference data only. No staff member, student, or known test account is seeded.
4. Bootstrap the first Administrator, run the persistent application worker, receive the verification message, verify the account, and replace the temporary password.
5. Create the intended academic year and closing date, then review capacity and reference data.
6. Onboard the Coordinator and both clinic staffs, import a valid CSV, and confirm publication in both clinic views.
7. Prove the student journey: mandatory email verification, schedule, attendance, result upload/finalization/edit, private download, and notifications.

Do not bootstrap before preflight passes. Bootstrap is serialized, refuses to run after a non-deleted Administrator exists, and queues the new Administrator's verification message. Keep `EMAIL_OUTBOX_ENCRYPTION_KEY` unchanged while encrypted pending messages exist.

Administrators create Coordinator and Clinic Staff accounts from Users. Every staff member must verify their email and replace the temporary password before operational access is granted. Students sign in separately with Student Number, Date of Birth, and their complete Middle Name; imported students receive the DOB and Middle Name from the CSV. Middle Name matching ignores capitalization only, so spacing and punctuation must exactly match the stored value.

## Academic-Year Student CSV

Download the Excel template, replace its synthetic sample row, and copy that formatted row for additional students. The Date of Birth cell uses a real Excel date with the fixed `yyyy-mm-dd` display format. Before upload, save the completed workbook as **CSV UTF-8** or Excel **CSV (Comma delimited)** / Windows-1252. The application does not accept XLSX uploads or UTF-16 CSV.

Use these headers in this exact order:

```csv
Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth
23-1212-97,Abad,Aaron Miguel,Abella,,College of Computer Studies,BSIT,3,2004-08-04
```

- Download the matching Excel template at [`public/templates/student-schedule-import-template.xlsx`](public/templates/student-schedule-import-template.xlsx).
- Date of Birth is required and uses the strict ISO `YYYY-MM-DD` format.
- Middle Name is required and must contain the complete name; Suffix may be blank. Names are displayed surname-first with only the first middle initial.
- College names and course codes must match active reference data case-insensitively.
- Files may contain up to 3,000 data rows and may not exceed 1 MB.
- Student IDs must be valid and unique within the file after normalization.
- Choose the student category and academic-year start. OJT and Tour imports also require a preferred month; Regular does not. First-Year/OVPSA imports use the guarded review with a Laboratory date.
- One POST validates references, acquires the scheduling lock, assigns acceptance order, upserts students, skips same-cycle duplicates, displaces only eligible Regular pairs when needed, creates both clinic batches, and publishes atomically.
- A failed row or protected/capacity conflict rolls back the complete import. New uploads do not create manual review checkpoints.
- Historical `DRAFT`, `VALIDATED`, and `GENERATED` imports remain readable, but no action can advance or publish them.
- Published First-Year/OVPSA batches retain their administrator-only history, emergency rescheduling, and cancellation lifecycle; those operations cannot create or publish a new batch.

Scheduling is Monday–Friday in Manila. Laboratory always precedes PE. Regular scheduling begins at the later of the first weekday in August or the seven-Manila-calendar-day preparation boundary. OJT and Tour scheduling use the selected academic-year month and the same preparation boundary. First-Year/OVPSA review assigns the fixed Laboratory date and capacity-aware PE dates before the same atomic publication request.

## Clinic Calendar and Date-Only Appointments

Administrators manage future holidays, closures, maintenance, and staff-unavailable ranges under **Administration → Clinic calendar**.

- CPU Clinic blocks move only active PE appointments; the paired Laboratory date stays unchanged.
- KABALAKA Clinic blocks replace both active appointments as a new pair.
- Eligible appointments are recovered automatically; protected or exhausted cases are retained in the Manual Resolution Required queue without discarding unrelated calendar changes.
- Historical `RESCHEDULED` and `CANCELLED` rows remain visible but do not block later closure calculations.
- Reopening a date makes it available for future scheduling and does not restore appointments automatically.
- Appointments expose only a date. No time-slot field is accepted or displayed.

Automatic no-shows run at the next local midnight after the appointment date. The Node worker performs startup catch-up, schedules the next Manila midnight, and retries a failed sweep after five minutes. Manual no-show assignment is rejected.

## Student Portal and Notifications

Use **Student sign in** from the public landing page. Authentication uses a separate HTTP-only `medclinic_student_session` cookie. Five failed attempts for the same normalized Student Number/IP pair cause a 15-minute lock. Login errors do not reveal whether a student exists, is inactive, lacks DOB or Middle Name, or which credential was incorrect.

Every student query is constrained to the session Student Number and revalidates the active student. The portal includes:

- Published date-only schedule and reschedule history
- Portal notifications with read state
- Mandatory email verification before portal access
- Laboratory and PE result drafts/downloads
- Logout

### Student middle-name Browser acceptance fixture

The student-authentication fixture creates one synthetic student and one blank-Middle-Name CSV under ignored `.data/` storage. Every fixture command requires a loopback PostgreSQL `DATABASE_URL` and an explicit `STUDENT_AUTH_ACCEPTANCE_EXCLUSIVE_DATABASE=1` opt-in. Set that flag only for a local database dedicated exclusively to this acceptance run.

```powershell
$env:STUDENT_AUTH_ACCEPTANCE_EXCLUSIVE_DATABASE = "1"
npm run acceptance:student-auth -- prepare
npm run acceptance:student-auth -- status
npm run acceptance:student-auth -- cleanup
```

`cleanup` removes the synthetic student and login attempts, verifies that no matching student or import remains, and removes the temporary CSV and state file.

Schedule changes and result invalidations create portal notifications in the business transaction. A verified email also creates an outbox item. Working SMTP is an installation prerequisite because staff and student verification is mandatory. After installation, a temporary delivery outage leaves mail queued for retry and does not roll back unrelated schedules, portal notices, or uploads.

To enable delivery, set:

```env
SMTP_HOST=smtp.example.edu
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=clinic@example.edu
```

Set both SMTP credentials when the provider requires authentication, or leave both empty. `EMAIL_OUTBOX_ENCRYPTION_KEY` must be a dedicated Base64 encoding of exactly
32 random bytes and must not reuse `JWT_SECRET`. Verification links use 32 random bytes, store only a SHA-256 token hash
in the verification table, and expire after 30 minutes. A previous verified address remains active until its replacement
is verified. The email worker polls every minute, uses `FOR UPDATE SKIP LOCKED`, retries up to ten attempts, and caps
exponential delay at one hour.

## Private Result Documents

Completing an appointment creates the matching `PENDING_UPLOAD` result if none exists. Existing manually recorded result statuses are preserved. Only the completed service becomes uploadable.

- Allowed: PDF, JPG/JPEG, and PNG with matching extension, declared MIME, and file signature
- Maximum 20 MB per file, 10 files per submission, and 50 MB combined
- Drafts support add, remove, and resume; inactive drafts expire after seven days
- Final submission creates the official revision and completes the result using the Manila date with no staff encoder
- A student may create an edit draft, retain or replace files, and submit a new official revision; previous official history remains available to authorized administrators
- Students can download only their own finalized files
- Only administrators can list other students' submissions, download individual documents/ZIPs, or invalidate a submission
- Invalidation keeps the appointment completed, resets the result to `PENDING_UPLOAD`, revokes prior metadata access, notifies the student, and opens a replacement draft

Files are stored beneath `RESULT_UPLOAD_ROOT` using generated submission/file IDs, never original names. Temporary files are atomically promoted, SHA-256 checksums are verified on download, and deletion failures remain retryable. Use an absolute path on durable private storage, restrict it to the application operating-system account, and never place it under `public/`. Every application/worker instance must see the same file state. The current adapter is a filesystem adapter and is not cloud object storage.

## Database Commands

```powershell
npm run db:migrate
npm run db:seed
```

Migrations 008 and 009 add academic-year ordering/cycles, displacement/closure metadata, student identity/notifications, private submission metadata, `PENDING_UPLOAD`, and the date-only appointment schema. Migration 010 normalizes the deprecated safe-capacity column to maximum capacity; application scheduling uses maximum capacity only. Migration 012 replaces the college/program catalog with the exact CPU workbook catalog. Migrations 020–025 consolidate First-Year/OVPSA imports, harden closure recovery, validate year/category policy, add verified student notifications, enforce clinic scope, and secure staff account lifecycles. Migration 026 removes configurable priority groups and the schedule-item priority-group column while preserving import, appointment, audit, and displacement history.

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

`npm test` and `npm run test:watch` run database-free unit/component tests with public synthetic configuration. They do not load `.env.local`, and unexpected database access fails immediately.

Database tests require a local PostgreSQL role with `CREATEDB` and an explicit, **new** database name beginning with `medclinic_test_`:

```powershell
$env:TEST_DATABASE_URL = "postgresql://test_role:your_local_password@127.0.0.1:5432/medclinic_test_integration"
$env:TEST_DATABASE_DISPOSABLE = "1"
npm run test:integration

# Uses a separate fresh target and the real production migration CLI:
$env:TEST_DATABASE_URL = "postgresql://test_role:your_local_password@127.0.0.1:5432/medclinic_test_migrations"
npm run test:migrations:empty
```

Both commands reject application names, remote destinations, URL overrides, and existing databases before fixtures. They create and verify their owned target, report cleanup, and drop it afterward. Integration tests apply migrations and reference seeds, then run staff fixtures and database tests serially. Child processes inherit that explicit target and synthetic application configuration. The migration-only proof checks exactly 27 migrations, a second zero-migration run, atomic rollback, and target removal. Neither command falls back to the application `DATABASE_URL`.

Together, the unit and integration suites cover schema/backfills, the exact nine-column CSV, 3,000-row atomic imports, scheduling windows/capacity/concurrency, displacement, closure rollback, manual locks, date-only no-shows, separate sessions/throttling, strict ownership, file signatures/limits, finalization, ZIP access, invalidation, cleanup, outbox retry, and the full cross-feature scenario. Database-free CI runs on Windows and Linux.

### Staff account security Browser acceptance fixture

This fixture creates a dedicated schema in an explicitly disposable loopback database, applies all migrations and reference seeds, proves the seed contains zero staff users, and performs the real one-time Administrator bootstrap. Start the application with the dedicated acceptance command so it uses that schema rather than the ordinary development schema:

```powershell
$env:STAFF_ACCOUNT_SECURITY_ACCEPTANCE_EXCLUSIVE_DATABASE = "1"
$env:APP_URL = "http://localhost:3012"
npm run acceptance:staff-account-security:setup
npm run acceptance:staff-account-security:dev
# Complete the Browser flow in another terminal, then stop the acceptance application.
npm run acceptance:staff-account-security:status
npm run acceptance:staff-account-security:cleanup
Remove-Item Env:STAFF_ACCOUNT_SECURITY_ACCEPTANCE_EXCLUSIVE_DATABASE
Remove-Item Env:APP_URL
```

Setup saves a credential-free database identity and the exact `APP_URL`; the dev launcher refuses a mismatch and probes the isolated schema before starting on that URL's host and port. Cleanup proves zero fixture users, tokens, staff outbox rows, related audits, historical fixture records, and state files before dropping the isolated schema.

### Scheduling integrity Browser acceptance fixture

This guarded fixture retains the appointment locking, pair-integrity, Manual Resolution, displacement, capacity, portal, and cleanup scenarios without creating priority groups or legacy scheduling batches. Run it only against a dedicated loopback acceptance database:

```powershell
$env:SCHEDULING_INTEGRITY_ACCEPTANCE_EXCLUSIVE_DATABASE = "1"
npm run acceptance:scheduling-integrity:setup
# Verify retained flows and ordinary 404 responses for removed scheduling routes in Browser.
npm run acceptance:scheduling-integrity:status
npm run acceptance:scheduling-integrity:cleanup
Remove-Item Env:SCHEDULING_INTEGRITY_ACCEPTANCE_EXCLUSIVE_DATABASE
```

Both `status` and `cleanup` verify the persisted database identity. Cleanup discovers the exact owned manifest, removes only those database rows and private files, restores capacity settings, and proves zero database, file, and state residue.

### Appointment protection Browser acceptance fixture

The focused appointment-protection fixture creates two synthetic students with exact owned appointment and pair IDs for the locking/inheritance and active-draft-file closure journeys. Every command requires a PostgreSQL `DATABASE_URL` on `localhost`, `127.0.0.1`, or `::1` plus an explicit `APPOINTMENT_PROTECTION_ACCEPTANCE_EXCLUSIVE_DATABASE=1` opt-in. Set that flag only while the configured local database is dedicated exclusively to this acceptance run.

```powershell
$env:APPOINTMENT_PROTECTION_ACCEPTANCE_EXCLUSIVE_DATABASE = "1"
npm run acceptance:appointment-protection -- prepare
# Complete the authenticated administrator, clinic-staff, and student Browser flows.
npm run acceptance:appointment-protection -- status
npm run acceptance:appointment-protection -- cleanup
Remove-Item Env:APPOINTMENT_PROTECTION_ACCEPTANCE_EXCLUSIVE_DATABASE
```

The ignored state is `.data/browser-appointment-protection/state.json`. `status` and `cleanup` refuse a database-identity or `RESULT_UPLOAD_ROOT` mismatch. Before deletion, cleanup persists all discovered appointment, submission, file, manual-case, reschedule, closure, notification, and audit IDs plus each private storage key. Its resumable phases delete only that exact manifest, constrain every private-file path beneath `RESULT_UPLOAD_ROOT`, and finish only after proving zero database, storage, and state residue.

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
4. Import an OJT or Tour category against constrained capacity and review the Regular student's linked replacement history and notification.
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
- Public schedule lookup is retired; students use the authenticated Student Portal for published schedule and compliance data.

For production:

```powershell
npm run build
npm start -- --hostname 0.0.0.0
```

Use HTTPS, set `APP_URL` accordingly, restrict PostgreSQL to the application host, and run the Node process under a supervisor that restarts it after failures and releases. The in-process email, no-show, and result-cleanup workers perform startup catch-up and require a persistent Node runtime. Back up and restore PostgreSQL and the private upload root as one coordinated recovery point. See the [deployment runtime contract](docs/installation.md#deployment-runtime-and-recovery-contract).
