# First installation and deployment contract

This guide starts with a completely empty PostgreSQL database. It does not require SQL edits, seeded people, known passwords, or a verification bypass. Complete all seven steps before treating an installation as usable.

## 1. Install compatible runtimes and locked dependencies

Install a maintained Node.js LTS release that satisfies Next.js's Node.js 20.9 minimum, plus npm and PostgreSQL 15 or later. As of September 2026, select Node.js 22 or 24 LTS for a new production installation; Node.js 20 is end-of-life. Recheck the [Node.js release schedule](https://nodejs.org/en/about/previous-releases) when deploying. The PostgreSQL role used for migration must be permitted to create the `pgcrypto` extension. Use the repository lockfile:

```powershell
node --version
psql --version
npm ci
```

Run commands from the same checked-out release that will be built and started. Do not copy `node_modules` from another operating system or Node version.

Current dependency verification dated 2026-09-15: `npm ci` installed the current lockfile on Windows with Node.js 26.4.0. The resolved tree contains Next.js 16.3.5 and one deduplicated Sharp 0.35.4 installation, retains React 19.2.4, and successfully loads native Sharp and generates a PNG. This dependency check does not replace the production build and complete runtime acceptance.

The earlier installation and preflight checks dated 2026-09-09 used the previous Next.js 16.2.6 and Sharp 0.34.5 dependency set on Windows with Node.js 26.4.0 and PostgreSQL 18.4. That evidence still covers PostgreSQL and preflight behavior, but it does not verify the current dependency tree. The repository CI workflow declares Node.js 22; that workflow and a Linux runner were not executed in either verification.

## 2. Configure and preflight every prerequisite

Copy `.env.example` to `.env.local` and replace every placeholder. Configure:

- `DATABASE_URL` for the empty application database.
- A strong `JWT_SECRET` of at least 32 characters.
- A separate `EMAIL_OUTBOX_ENCRYPTION_KEY`, generated as Base64 for exactly 32 random bytes. Never rotate it while encrypted messages are pending.
- `APP_URL` as the actual browser origin, including HTTPS in production.
- `APP_TIMEZONE=Asia/Manila`.
- `RESULT_UPLOAD_ROOT` as an absolute path on durable private storage outside the repository and `public/`. Restrict access to the application operating-system account.
- `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM`. Set `SMTP_USER` and `SMTP_PASS` together when authentication is required; otherwise leave both empty.

Generate independent secrets, then place the values directly in `.env.local` without printing them in tickets or logs:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Create the empty database using your normal PostgreSQL administration process, then run:

```powershell
npm run install:preflight
```

Preflight validates all configuration before it opens a connection. It then proves the database and SMTP server are reachable and that the configured private result directory is currently writable. A successful write probe cannot prove that the deployment volume is durable, shared consistently by instances, protected by the required operating-system access controls, or included in coordinated backups; verify those deployment properties separately. Preflight reports only the observed checks and corrective guidance, and it does not print credentials, mail bodies, or verification URLs. A missing SMTP host/from or partially configured SMTP authentication fails before Administrator bootstrap can write to the database.

For automated local acceptance, `npm run smtp:acceptance` starts a development-only sink on `127.0.0.1:2525` and accepts only recipients beneath the reserved `.test` top-level domain. Its routine output prints only the listener and capture count. Acceptance code can deliberately inspect captured messages by importing `startLoopbackSmtpSink` from `scripts/loopback-smtp-sink.ts`; do not use this sink as a production mail service.

## 3. Apply migrations and reference seeds

Apply the production migration chain and the idempotent reference catalog seed:

```powershell
npm run db:migrate
npm run db:seed
```

The seed supplies clinics, colleges, programs, and capacity/reference values. It does not create an Administrator, clinic staff, Coordinator, student, academic year, or test account. On a new database, confirm both people tables remain empty before continuing. Do not run Browser fixtures or the integration suite against this database; those workflows own and remove separate disposable databases.

## 4. Bootstrap and complete the first Administrator account

Keep the configured SMTP service available. Set bootstrap values only for this process and use a unique temporary password:

```powershell
$env:BOOTSTRAP_ADMIN_FULL_NAME = "First Administrator"
$env:BOOTSTRAP_ADMIN_EMAIL = "administrator@example.edu"
$env:BOOTSTRAP_ADMIN_TEMPORARY_PASSWORD = "replace-with-a-unique-temporary-password"
npm run admin:bootstrap
Remove-Item Env:BOOTSTRAP_ADMIN_FULL_NAME, Env:BOOTSTRAP_ADMIN_EMAIL, Env:BOOTSTRAP_ADMIN_TEMPORARY_PASSWORD
```

`admin:bootstrap` runs the complete installation preflight first. It then creates exactly one unverified Administrator and queues an encrypted verification message atomically. It refuses to run when a non-deleted Administrator already exists.

Build and start the application under the persistent process model described below:

```powershell
npm run build
npm start -- --hostname 0.0.0.0
```

Receive the message through the configured SMTP destination, open the staff verification link, sign in, and replace the temporary password when prompted. Confirm the Administrator dashboard opens. Do not read a token from the database or disable verification.

## 5. Configure the intended academic year and operating settings

In **Administration → Academic years**, create the intended academic-year start and its actual closing date. An empty installation intentionally has no arbitrary current-year row, and schedule imports are unavailable until the selected year is configured.

Review **Daily capacity** and **Reference data** for the intended operation. Add or activate required college/program values before importing students. Use the unified **Clinic calendar** for dates that apply to scheduling across both services. In **Medical certificate physicians**, create an active physician profile with the authorized name, license number, and PNG/JPEG signature supplied by the Administrator. Examination completion is unavailable until a profile is configured.

## 6. Onboard staff and publish the first student import

In **Clinic users**, create the Coordinator and staff for both the KABALAKA Clinic and CPU Clinic. Each account must receive its own email verification, verify, and replace its temporary password.

As the Coordinator, export the provided workbook as a supported CSV, select the configured academic year and import mode/category, and submit it once. A successful import publishes the student records and both clinic schedules atomically. Confirm the import is `PUBLISHED` and the expected appointments appear in both clinic views.

## 7. Verify the complete student and clinical result journey

Use an imported synthetic or authorized acceptance student. Sign in with Student Number, date of birth, and complete Middle Name. Register an email address, receive the student verification message, and verify it before expecting portal access.

Confirm the student can view the published schedule and notifications. KABALAKA Clinic staff verify CBC, Urine, Stool, and the applicable X-ray one test at a time. A checked test records staff confirmation; a document upload never checks a test. If an unfinished Laboratory visit must move, use Manual Resolution or the reviewed bulk replacement flow and confirm its verified tests remain attached to the replacement. CPU Clinic staff enter the physician's actual Class A–D finding, remarks, examination date, sex, and physician in the examination completion form, preview the marked JPG, then save once to complete the appointment and issue the certificate. Confirm the student can download the issued JPG, and that another student cannot.

The student may upload, revise, finalize, and download **Laboratory** PDF/JPEG/PNG documents. Physical Examination student uploads are retired. The Administrator may download Laboratory files/ZIPs, invalidate a finalized Laboratory submission with a reason, and inspect its retained revisions. The CPU Clinic or Administrator may correct an issued certificate through a new immutable revision; an Administrator may revoke it with a reason. Confirm the student sees the current certificate status and previous academic-year downloads.

Finalized results are not permanently immutable to the student: editing creates a separate draft based on the official revision, and submitting changes creates a new official revision while authorized history remains. Administrator invalidation retains history, records a reason, notifies the student, and opens the replacement path.

The **Clinic calendar** shows Laboratory and Physical Examination used/maximum capacity and day details grouped by college and service. Red means at least one internal service is full. Closure drafts and impact review remain separate from occupancy. CPU Clinic closures recover active PE work while retaining its paired Laboratory appointment; KABALAKA Clinic closures recover the active pair. Partially verified Laboratory work and other protected cases enter **Manual Resolution Required**. Reopening a date permits future scheduling there and never restores earlier appointments automatically.

After an academic year's Manila closing date, its appointments leave current lists and remain in the explicit year/history views. Clinical changes and replacements are closed for that year; authorized Laboratory documents and issued certificates remain downloadable.

## Deployment runtime and recovery contract

The production architecture runs email delivery, automatic no-show, and abandoned-result cleanup as in-process workers. Run `next start` as a persistent Node process under a supervisor that starts it after boot, restarts it after failures/releases, captures logs, and allows graceful shutdown. Verify pending jobs catch up after every restart or release. A request-only/serverless process is incompatible unless these workers are moved to an external durable scheduler before deployment.

`RESULT_UPLOAD_ROOT` is the live filesystem storage adapter. Mount durable private storage at the same absolute path for every application/worker instance that can handle result files. Verify an existing upload remains downloadable across process restart and release replacement. An ephemeral filesystem is incompatible; a serverless deployment needs a durable object-storage adapter before deployment. This repository does not select a hosting or storage vendor.

Treat PostgreSQL and `RESULT_UPLOAD_ROOT` as one recoverable system. Quiesce writes or use a coordinated snapshot method, capture both at the same recovery point, retain encryption material separately and securely, and test restoring both together. Restoring only the database can leave file metadata without objects; restoring only files can expose unreferenced private data.

A temporary SMTP outage after installation does not roll back scheduling, notification, or upload transactions. Mail remains in the transactional outbox for the existing bounded retry policy and appears in the Administrator email-delivery monitor when intervention is required. Missing SMTP configuration is different: preflight blocks first bootstrap because mandatory verification cannot complete.
