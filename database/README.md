# Database Setup

Set `DATABASE_URL`, then run:

```powershell
npm run db:migrate
npm run db:seed
```

For a disposable local database only, reset with:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
```

`db:reset` refuses to run against the `postgres`, `template0`, or `template1` databases.
