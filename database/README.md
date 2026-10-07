# Database Setup

For first installation, configure an empty application database and private storage, then follow [installation](../docs/installation.md): preflight → migrate → seed → Administrator bootstrap/email confirmation/password replacement → academic-year configuration.

After configuration, run:

```powershell
npm run install:preflight
npm run db:migrate
npm run db:seed
```

Migration `028_final_defense_clinical_workflows.sql` is for a fresh clinical database. It rejects preexisting appointment/result data because CBC, Urine, Stool, X-ray, physician findings, and certificate signatures cannot be inferred. It adds immutable Laboratory checklist lineage, physician profile revisions, certificate JPEG revisions, and atomic clinical request outcomes. Student result submissions are Laboratory-only. Validate a clean installation with `npm run test:migrations:empty` against a disposable database; the runner must apply exactly 32 migrations through `032_default_clinic_capacity_100.sql` first and 0 on replay. Retain the complete 001–032 chain.

Migrate before seeding. The fresh reference seed initializes KABALAKA Laboratory and CPU Physical Examination to separate maximums of 100 students per day. Administrators can independently save another positive integer, including values above 100. Migration 032 changes only the omitted-column SQL default; it does not rewrite saved capacities or appointments. Replaying the seed preserves existing rows and custom values. Previously seeded developer databases keep their saved maximums; ordinary first installation does not use reset.

Migration 030 removes the obsolete safe-capacity column and enforces a positive maximum. Migration 031 requires category/year provenance and an authoritative service date, permits only published/cancelled generic batches and scheduled items, and removes manual override/week/failed-validation metadata. It refuses unsupported existing rows atomically with `UNSUPPORTED_PREDEPLOYMENT_SCHEDULING_DATA`; do not reset, rewrite or delete application data to bypass that refusal. Successful validation/publication evidence and OVPSA transaction states remain intact.

## CPU reference catalog

Migration 012 and the seed establish the canonical 13-college/48-program CPU catalog for fresh installation. The old catalog-conversion command is retired; historical migration notices do not authorize conversion or deletion of developer data.

For a developer-owned disposable local database only, reset with:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
```

Reset recreates the public schema, runs the canonical per-migration transactional executor, then seeds references. It is not the installation or deployment path. `db:reset` refuses to run against the `postgres`, `template0`, or `template1` databases.
