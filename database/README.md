# Database Setup

Set `DATABASE_URL`, then run:

```powershell
npm run db:migrate
npm run db:seed
```

Migration `028_final_defense_clinical_workflows.sql` is for a fresh clinical database. It rejects preexisting appointment/result data because CBC, Urine, Stool, X-ray, physician findings, and certificate signatures cannot be inferred. It adds immutable Laboratory checklist lineage, physician profile revisions, certificate JPEG revisions, and atomic clinical request outcomes. Student result submissions are Laboratory-only. Validate a clean installation with `npm run test:migrations:empty` against a disposable database; the runner must apply 29 migrations first and 0 on replay.

## CPU reference catalog

Migration 012 and the seed establish the canonical 13-college/48-program CPU catalog for fresh installation. The old catalog-conversion command is retired; historical migration notices do not authorize conversion or deletion of developer data.

For a disposable local database only, reset with:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
```

`db:reset` refuses to run against the `postgres`, `template0`, or `template1` databases.
