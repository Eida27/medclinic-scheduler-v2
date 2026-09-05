# Snapshot Provenance Integrity Follow-Up Design

**Project:** MedClinic Scheduler V2  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Date:** 2026-09-05  
**Status:** Approved follow-up design  
**Scope:** Only the three findings from the post-implementation review of the Reports Data-Quality cleanup.  
**Deployment assumption:** The system has still never been deployed to production. The first production database will be completely fresh.

## 1. Objective

Finish the Reports/snapshot cleanup by hardening the new canonical provenance model without reintroducing legacy Data Quality concepts or creating a compatibility layer.

This follow-up has exactly three goals:

1. make `SNAPSHOT_CONFLICT_DETECTED` auditing durable and consistent for both standard and First-Year/OVPSA imports;
2. guarantee that a snapshot and its `source_import_group_id` belong to the same academic year;
3. make the import-group fields that define snapshot provenance immutable after creation.

No other Reports, scheduling, appointment, OVPSA lifecycle, authentication, notification, or upload behavior should change.

## 2. Pre-Deployment Migration Strategy

Because production has never been deployed, do **not** add a new corrective migration whose only purpose is to repair the current pre-production schema.

Modify the existing migration chain in place:

- `database/migrations/016_reports_historical_compliance.sql` for snapshot/import academic-year integrity;
- `database/migrations/020_first_year_schedule_import_consolidation.sql` for canonical import-provenance immutability.

Any local/test database that already applied the old versions of these migrations must be rebuilt from scratch before verification.

Use the repository's disposable database reset workflow only on a dedicated local/test database. Never reset a real shared or production database.

## 3. Finding 1 — Durable Snapshot Conflict Auditing

### Current problem

Standard imports preserve `SNAPSHOT_CONFLICT_DETECTED` because they allow the transaction containing the conflict audit to commit and throw `SNAPSHOT_CONFLICT` afterward.

First-Year/OVPSA publication currently throws `SNAPSHOT_CONFLICT` **inside** its transaction. The transaction wrapper rolls back the entire transaction, including the conflict audit written by the snapshot gateway.

The same immutable-history conflict therefore has different audit behavior depending on import mode.

### Required behavior

For both publication modes:

```text
snapshot conflict detected
        ↓
no student/profile publication changes survive
no import group survives
no schedule batch survives
no appointment survives
no OVPSA publication state survives
        ↓
exactly one SNAPSHOT_CONFLICT_DETECTED audit survives
        ↓
caller receives SNAPSHOT_CONFLICT
```

The conflict audit must describe the same conflict payload currently produced by the snapshot gateway.

### Architecture

Do not duplicate conflict-audit JSON assembly in multiple services.

Extract the existing conflict-audit write into a focused shared repository helper in:

```text
src/server/repositories/student-academic-snapshots.repository.ts
```

Suggested responsibility:

```ts
writeStudentAcademicSnapshotConflictAuditWithClient(...)
```

The exact function name may follow existing repository naming conventions, but there must be one source of truth for:

- action: `SNAPSHOT_CONFLICT_DETECTED`;
- entity type;
- single-conflict entity ID behavior;
- academic year metadata;
- conflict count;
- conflict array.

`ensureStudentAcademicSnapshotsWithClient(...)` may continue using that helper when it detects conflicts.

### First-Year transaction behavior

In `src/server/services/first-year-schedule-import.service.ts`, preserve all-or-nothing publication semantics while allowing the audit to commit.

Use a database savepoint around the mutation portion of First-Year publication:

```text
BEGIN outer transaction
  acquire locks / recompute authoritative plan
  SAVEPOINT first_year_publication

  mutate profiles/import/snapshots/publication state

  if snapshot conflict:
      ROLLBACK TO SAVEPOINT first_year_publication
      write the shared conflict audit after the rollback
      return a conflict sentinel from the transaction

COMMIT outer transaction

outside transaction:
  convert conflict sentinel to AppError("SNAPSHOT_CONFLICT", ...)
```

The savepoint must be established **before the first write that belongs to the attempted First-Year publication**, including student-profile upserts and the import-group insert.

Do not manually try to reverse individual student/profile/import/appointment writes. The savepoint is the rollback boundary.

Do not catch and swallow unrelated errors. Non-snapshot failures should continue to abort and roll back the outer transaction normally.

### Standard import

Do not change standard import semantics unless needed to reuse the shared audit helper. Its existing durable conflict-audit behavior should remain.

## 4. Finding 2 — Snapshot and Import Group Must Share the Same Academic Year

### Current problem

`student_academic_snapshots.source_import_group_id` currently references only `schedule_import_groups(id)`.

That guarantees the import group exists, but it does not guarantee:

```text
snapshot.academic_year_start
=
schedule_import_groups.academic_year_start
```

Because the import group is now the canonical provenance source, this relationship must be enforced by the database.

### Required database invariant

In `database/migrations/016_reports_historical_compliance.sql`, replace the single-column provenance FK with an academic-year-aware composite relationship.

Add a unique key usable as the referenced target:

```sql
ALTER TABLE schedule_import_groups
  ADD CONSTRAINT schedule_import_groups_id_academic_year_key
  UNIQUE (id, academic_year_start);
```

Define the snapshot relationship as:

```sql
FOREIGN KEY (source_import_group_id, academic_year_start)
  REFERENCES schedule_import_groups(id, academic_year_start)
  ON DELETE RESTRICT
```

The existing snapshot fields remain:

```text
source_import_group_id UUID NOT NULL
academic_year_start INTEGER NOT NULL
```

The existing index on `student_academic_snapshots(source_import_group_id)` should remain unless query analysis proves it redundant.

### Important scope rule

Do not make `schedule_import_groups.academic_year_start` globally `NOT NULL` as part of this follow-up unless an existing repository invariant already requires it everywhere.

The composite FK is sufficient to guarantee that any import group referenced by a snapshot has the same non-null academic year as that snapshot.

### Gateway behavior

The database constraint is the authoritative invariant.

Do not add a second parallel provenance-validation subsystem or a new compatibility abstraction. If the application adds a defensive pre-check for a clearer internal error, it must remain a thin check and must not replace the database FK.

## 5. Finding 3 — Canonical Import Provenance Must Be Immutable

### Current problem

`accepted_at` is already immutable, but the new snapshot architecture also relies on these import-group fields as historical provenance:

```text
academic_year_start
import_mode
first_year_laboratory_date
```

If those values can be changed after snapshot creation, the meaning of an immutable snapshot can change indirectly through its provenance row.

### Required invariant

In `database/migrations/020_first_year_schedule_import_consolidation.sql`, add a focused trigger/function that rejects updates to the provenance-defining fields:

```text
academic_year_start
import_mode
first_year_laboratory_date
```

`accepted_at` continues to use its existing immutability protection from migration 008.

Suggested behavior:

```sql
IF NEW.academic_year_start IS DISTINCT FROM OLD.academic_year_start
   OR NEW.import_mode IS DISTINCT FROM OLD.import_mode
   OR NEW.first_year_laboratory_date IS DISTINCT FROM OLD.first_year_laboratory_date
THEN
  RAISE EXCEPTION 'schedule import provenance identity is immutable'
    USING ERRCODE='23514';
END IF;
```

Attach the trigger only to updates of those fields.

### What may still change

Do not broadly freeze the entire `schedule_import_groups` row. Existing non-provenance operational/display fields should retain their current behavior unless already protected elsewhere.

This follow-up is specifically about the identity that historical snapshots depend on.

## 6. Required Tests

### A. First-Year conflict audit durability

Update or add an integration test in:

```text
src/server/services/first-year-schedule-import.integration.test.ts
```

The test must:

1. configure the academic year;
2. create an existing immutable snapshot for a First-Year candidate;
3. attempt a First-Year publication containing conflicting academic data;
4. expect `SNAPSHOT_CONFLICT`;
5. verify the conflict audit count increases by exactly one;
6. verify no attempted import group survives;
7. verify no new OVPSA batch/revision/reservation survives;
8. verify no appointment survives;
9. verify no attempted student-profile mutation survives;
10. verify the original academic snapshot remains unchanged.

This is the key regression test for Finding 1.

### B. Composite academic-year provenance FK

Update:

```text
src/server/db/reports-academic-snapshot-schema.integration.test.ts
```

Assert:

1. a snapshot can reference an import group with the same academic year;
2. a snapshot referencing a nonexistent import group is rejected;
3. a snapshot for year A referencing a real import group from year B is rejected;
4. deleting a referenced import group remains restricted;
5. the legacy `source_type` and `source_metadata` columns remain absent.

### C. Snapshot gateway provenance tests

Update:

```text
src/server/repositories/student-academic-snapshots.repository.integration.test.ts
```

Keep existing coverage for:

- first-import provenance;
- identical later import idempotency;
- immutable snapshot rows;
- mixed-set conflict atomicity.

Add a mismatch case proving a candidate cannot create a snapshot through an import group belonging to another academic year.

The database constraint must be what ultimately prevents invalid persistence.

### D. Import provenance immutability

Add focused migration/integration assertions, preferably alongside existing import/migration tests, proving that after an import group exists:

```text
UPDATE academic_year_start → rejected
UPDATE import_mode → rejected
UPDATE first_year_laboratory_date → rejected
```

Also verify legitimate updates to unrelated mutable fields are not accidentally blocked.

### E. Standard import regression

Keep the existing standard-import conflict test that proves:

```text
SNAPSHOT_CONFLICT returned
exactly one conflict audit survives
attempted import group does not survive
```

Do not weaken that behavior while sharing conflict-audit code.

## 7. Anti-Spaghetti Rules

1. **One audit formatter/writer.** Do not construct `SNAPSHOT_CONFLICT_DETECTED` metadata separately in standard and First-Year services.
2. **One database truth for academic-year provenance.** Use the composite FK; do not rely only on TypeScript checks.
3. **No compensating migration.** Production is still fresh, so correct migrations 016/020 directly.
4. **No legacy compatibility fields.** Do not restore `source_type`, `source_metadata`, Data Quality, or migration fallback concepts.
5. **No manual rollback lists for First-Year conflict handling.** Use a transaction savepoint rather than trying to undo individual rows.
6. **Do not freeze unrelated import-group behavior.** Protect only provenance identity fields required by this design.
7. **Do not change Reports UI/PDF contracts.** The existing seven-column Reports model remains correct.
8. **Do not change OVPSA operational causes.** `OVPSA_PUBLICATION`, `OVPSA_RESCHEDULE`, cancellation, restoration, and displacement event behavior remain unchanged.

## 8. Files Expected to Change

Primary files:

```text
database/migrations/016_reports_historical_compliance.sql
database/migrations/020_first_year_schedule_import_consolidation.sql
src/server/repositories/student-academic-snapshots.repository.ts
src/server/services/first-year-schedule-import.service.ts
src/server/db/reports-academic-snapshot-schema.integration.test.ts
src/server/repositories/student-academic-snapshots.repository.integration.test.ts
src/server/services/first-year-schedule-import.integration.test.ts
```

Additional focused test files may change only if needed to verify migration 020 or standard-import regression behavior.

Do not perform unrelated refactors.

## 9. Verification

After implementation, use a completely disposable fresh local database and run at minimum:

```powershell
$env:ALLOW_DB_RESET="true"
npm run db:reset
Remove-Item Env:ALLOW_DB_RESET

npm test
npm run test:migrations:empty
npm run lint
npm run build
git diff --check
```

A local database that already applied the old migration 016/020 must be rebuilt; `db:migrate` alone is not sufficient because edited migration filenames are already recorded as applied.

## 10. Acceptance Criteria

The follow-up is complete only when all of the following are true:

1. Standard and First-Year snapshot conflicts both surface `SNAPSHOT_CONFLICT`.
2. Exactly one `SNAPSHOT_CONFLICT_DETECTED` audit survives for either import mode.
3. A failed First-Year conflict leaves no publication/profile/import/appointment residue.
4. A snapshot cannot reference an import group from another academic year.
5. A snapshot still cannot reference a nonexistent import group.
6. Referenced import groups still cannot be deleted.
7. `schedule_import_groups.academic_year_start` cannot be changed after creation.
8. `schedule_import_groups.import_mode` cannot be changed after creation.
9. `schedule_import_groups.first_year_laboratory_date` cannot be changed after creation.
10. Existing `accepted_at` immutability still works.
11. Standard scheduling behavior is unchanged.
12. First-Year/OVPSA scheduling, rescheduling, cancellation, restoration, and displacement behavior is unchanged.
13. Reports remain free of Data Quality/source-type concepts.
14. Migrations apply successfully from a completely empty database.
15. Full tests, empty-migration tests, lint, build, and `git diff --check` pass.

## 11. Non-Goals

Do not change:

- Reports filters, table columns, summary cards, or PDF layout;
- historical compliance classifications;
- student authentication;
- result uploads;
- clinic capacities;
- Laboratory/Physical Examination scheduling rules;
- priority displacement policy;
- clinic closure behavior;
- notifications;
- academic-year closing-state rules;
- OVPSA lifecycle event causes.

## 12. Final Design Principle

After this follow-up, the historical snapshot model should have three aligned guarantees:

```text
Immutable academic snapshot
        +
Same-year authoritative import provenance
        +
Immutable provenance identity
```

A failed publication must leave no operational state behind while still leaving a durable audit record explaining why immutable academic history prevented the publication.
