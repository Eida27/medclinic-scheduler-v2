# Database Setup

Set `DATABASE_URL`, then run:

```powershell
npm run db:migrate
npm run db:seed
```

## CPU reference catalog migration

Migration `012_cpu_reference_catalog.sql` makes the 13-college/48-program CPU workbook catalog authoritative, deletes noncanonical catalog rows, removes `Graduating`, and ranks OJT/Tour/Regular as 1/2/3. For an existing database, back up both PostgreSQL and `RESULT_UPLOAD_ROOT`, stop application/worker writes, and run the guarded cleanup during an exclusive maintenance window:

```powershell
npm run db:reference-catalog-cleanup -- plan
$env:REFERENCE_CATALOG_CLEANUP_EXCLUSIVE_DATABASE="1"
$env:REFERENCE_CATALOG_CLEANUP_CONFIRM="DELETE_NON_WORKBOOK_REFERENCE_DATA"
npm run db:reference-catalog-cleanup -- apply
npm run db:reference-catalog-cleanup -- status
npm run db:migrate
```

`plan` is read-only. `apply` persists a manifest in `.data/reference-catalog-cleanup/state.json`, commits database deletion before deleting private files, and resumes file deletion after a failure. It removes students assigned to noncanonical references and removes each whole atomic import group affected by one of those students. Do not run it without verified backups and exclusive access.

For a disposable local database only, reset with:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
```

`db:reset` refuses to run against the `postgres`, `template0`, or `template1` databases.
