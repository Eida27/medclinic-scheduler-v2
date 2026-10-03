# Database Setup

For first installation, configure an empty application database and private storage, then follow [installation](../docs/installation.md): preflight → migrate → seed → Administrator bootstrap/email confirmation/password replacement → academic-year configuration.

After configuration, run:

```powershell
npm run install:preflight
npm run db:migrate
npm run db:seed
```

Migration `028_final_defense_clinical_workflows.sql` is for a fresh clinical database. It rejects preexisting appointment/result data because CBC, Urine, Stool, X-ray, physician findings, and certificate signatures cannot be inferred. It adds immutable Laboratory checklist lineage, physician profile revisions, certificate JPEG revisions, and atomic clinical request outcomes. Student result submissions are Laboratory-only. Validate a clean installation with `npm run test:migrations:empty` against a disposable database; the runner must apply exactly 31 migrations through `031_retire_manual_schedule_metadata.sql` first and 0 on replay.

Migration 030 removes the obsolete safe-capacity column and enforces a positive maximum. Migration 031 requires category/year provenance and an authoritative service date, permits only published/cancelled generic batches and scheduled items, and removes manual override/week/failed-validation metadata. It refuses unsupported existing rows atomically with `UNSUPPORTED_PREDEPLOYMENT_SCHEDULING_DATA`; do not reset, rewrite or delete application data to bypass that refusal. Successful validation/publication evidence and OVPSA transaction states remain intact.

## CPU reference catalog

Migration 012 and the seed establish the canonical 13-college/48-program CPU catalog for fresh installation. The old catalog-conversion command is retired; historical migration notices do not authorize conversion or deletion of developer data.

For a developer-owned disposable local database only, reset with:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
```

Reset recreates the public schema, runs the canonical per-migration transactional executor, then seeds references. It is not the installation or deployment path. `db:reset` refuses to run against the `postgres`, `template0`, or `template1` databases.
