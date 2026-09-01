# Reports Data-Quality and Historical-Migration Cleanup

**Project:** MedClinic Scheduler V2  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Date:** 2026-09-01  
**Status:** Approved pre-deployment design  
**Deployment assumption:** The school production database has never been deployed and will start completely fresh.

## 1. Objective

Simplify the Reports and academic-year snapshot architecture by removing the legacy historical-migration/data-quality subsystem that was designed for databases containing pre-existing appointment history.

The production system will begin with a clean database. Therefore:

- there is no legacy production appointment history to recover;
- there is no need to classify snapshots as recovered or incomplete migrations;
- Reports should not expose migration provenance as "Data Quality";
- academic-year snapshots must remain immutable and historically accurate;
- standard and First-Year/OVPSA imports must create the same canonical type of academic snapshot;
- provenance should be represented by the existing schedule import relationship rather than a second classification system.

The result must be simpler, strongly typed, easier to maintain, and free of the current Reports/OVPSA source-type inconsistency.

## 2. Core Architectural Decision

### Keep

Keep the following concepts:

- `academic_years`
- `student_academic_snapshots`
- one immutable academic snapshot per student per academic year
- historical student name
- historical college
- historical program
- historical year level
- snapshot conflict detection
- academic-year closing dates
- Reports compliance classification
- Laboratory and Physical Examination historical statuses
- Reports filtering, sorting, pagination and PDF export
- administrator-only Reports access

Academic snapshots remain essential because historical reports must not change when a student's current academic profile later changes.

### Remove

Remove the user-facing and domain-level concepts:

- `VERIFIED_HISTORICAL`
- `RECOVERED_HISTORICAL`
- `MIGRATED_INCOMPLETE`
- `HistoricalDataQuality`
- `historicalDataQualityLabel`
- `dataQuality`
- `migratedIncomplete`
- historical recovery/fallback snapshot generation
- historical migration warnings
- Data Quality filtering
- Data Quality report-table column
- Data Quality PDF column/filter
- migration audit logic whose only purpose is recovering pre-existing historical records

Do not replace Data Quality with another Reports field such as "Standard Import", "OVPSA Import", "Snapshot Source", or "Provenance". Reports should focus on compliance, not internal persistence provenance.

## 3. Canonical Snapshot Provenance Model

Use `source_import_group_id` as the single provenance link for a student academic snapshot.

The source import group already contains authoritative import information and, after migration `020_first_year_schedule_import_consolidation.sql`, distinguishes:

```text
import_mode = STANDARD
or
import_mode = FIRST_YEAR_OVPSA
```

Therefore `student_academic_snapshots` must not duplicate this information with a separate `source_type`.

### Target snapshot schema

```text
student_academic_snapshots
├── id
├── student_number
├── academic_year_start
├── student_name
├── college_id
├── college_name
├── program_id
├── program_code
├── program_name
├── year_level
├── source_import_group_id
└── created_at
```

Remove:

```text
source_type
source_metadata
```

Change `source_import_group_id` to a required foreign key:

```sql
source_import_group_id UUID NOT NULL
  REFERENCES schedule_import_groups(id)
  ON DELETE RESTRICT
```

Add an index if one does not already exist:

```sql
CREATE INDEX student_academic_snapshots_source_import_group_idx
  ON student_academic_snapshots(source_import_group_id);
```

Rationale:

1. Every new production snapshot originates from an authoritative schedule import.
2. Both the standard workflow and First-Year/OVPSA workflow create a `schedule_import_groups` row.
3. `schedule_import_groups.import_mode` already identifies the workflow.
4. Duplicating this distinction in `student_academic_snapshots.source_type` violates single-source-of-truth.
5. A foreign key prevents orphan provenance.

## 4. Pre-Deployment Migration Strategy

Because this application has not been deployed to production, do **not** create a new migration merely to undo legacy behavior introduced by migrations `016` and `019`.

Instead, clean the existing migration chain so that a brand-new deployment creates the intended schema from the beginning.

This is intentionally a pre-production migration rewrite.

Any disposable local/test database that has already applied the old migrations must be rebuilt from scratch after these changes. Do not attempt to rely on `db:migrate` to re-run edited migration files that are already recorded in `schema_migrations`.

Never reset a real production/shared database.

## 5. Rewrite Migration 016

File:

```text
database/migrations/016_reports_historical_compliance.sql
```

This migration currently mixes two responsibilities:

1. defining Reports/academic-snapshot schema;
2. recovering records from a hypothetical pre-existing database.

Remove responsibility #2 completely.

### Keep

Keep:

- `academic_years`
- generated academic-year label
- closing-date constraint
- timestamps
- updated-at trigger
- `student_academic_snapshots`
- immutable snapshot trigger
- reporting indexes
- appointment historical-reporting index
- `ensure_student_academic_snapshots(...)`
- concurrency protection
- academic-year existence validation
- duplicate snapshot protection
- academic-field conflict detection
- snapshot conflict auditing

### Change the snapshot table

Remove:

```sql
source_type VARCHAR(30) NOT NULL
source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
student_academic_snapshots_source_type_check
```

Change `source_import_group_id UUID` to:

```sql
source_import_group_id UUID NOT NULL
  REFERENCES schedule_import_groups(id)
  ON DELETE RESTRICT
```

### Change `ensure_student_academic_snapshots`

Remove `source_type` and `source_metadata` from every `jsonb_to_recordset(...)` candidate shape.

Candidate input should contain only:

```text
student_number
academic_year_start
student_name
college_id
college_name
program_id
program_code
program_name
year_level
source_import_group_id
```

The INSERT performed by the function must contain only those snapshot fields.

A snapshot without a valid import group is invalid.

### Preserve conflict semantics

A snapshot conflict is based on historical academic information:

- student name
- college ID
- college name
- program ID
- program code
- program name
- year level

Do not overwrite an existing snapshot.

An identical later import for the same student/year remains idempotent.

If a later import has identical academic information but comes from another import group, preserve the original snapshot and original `source_import_group_id`. The first successfully created snapshot remains authoritative for that academic year.

### Delete historical backfill behavior

Delete SQL whose purpose is to inspect appointments that existed before migration 016 and infer:

- academic-year owners;
- academic years;
- historical student profiles;
- recovered imports;
- current-profile fallback;
- recovery evidence;
- migration source classification.

Remove concepts including:

```text
cycle_owner_candidates
ranked_cycle_owners
cycle_owners
reporting_population
recovery_candidates
best_recovery
snapshot_rows
```

There must be no automatic creation of historical academic years from old appointments. Academic years are explicitly configured by the administrator before scheduling.

### Delete historical migration auditing

Remove:

```text
HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED
verifiedHistoricalCount
recoveredHistoricalCount
migratedIncompleteCount
recoveryRule
fallbackRule
CURRENT_PROFILE_FALLBACK
PUBLISHED_IMPORT_GROUP
```

Migration 016 should create schema and invariants only.

## 6. Clean Migration 019 Without Breaking OVPSA

File:

```text
database/migrations/019_first_year_ovpsa_priority_scheduling.sql
```

Remove only the block that modifies `student_academic_snapshots_source_type_check`.

Migration 019 must no longer add `OVPSA_PUBLICATION` as an academic-snapshot source type, because snapshots no longer have `source_type`.

### Critical non-goal

Do **not** globally delete `OVPSA_PUBLICATION`.

It remains a legitimate operational cause/event in the OVPSA scheduling and displacement lifecycle, including `appointment_reschedule_events.cause` and related lifecycle/displacement code.

Only remove its use as a `student_academic_snapshots` source classification.

## 7. Snapshot Repository Refactor

File:

```text
src/server/repositories/student-academic-snapshots.repository.ts
```

Delete `StudentAcademicSnapshotSource` and all values:

```text
VERIFIED_HISTORICAL
RECOVERED_HISTORICAL
MIGRATED_INCOMPLETE
OVPSA_PUBLICATION
```

Simplify `StudentAcademicSnapshotCandidate` by removing:

```ts
sourceType
sourceMetadata
```

Keep:

```ts
sourceImportGroupId: string
```

It should no longer be nullable in normal application code.

Do not serialize `source_type` or `source_metadata` into the SQL gateway payload.

Delete the historical-recovery helper:

```ts
ensureBatchStudentAcademicSnapshotsWithClient
```

and supporting code such as:

```text
BatchSnapshotRow
evidence_time
RECOVERED_HISTORICAL branching
MIGRATED_INCOMPLETE branching
legacy publication metadata
```

Remove imports that become unused.

The repository should have one responsibility:

> Create an immutable academic-year snapshot from authoritative publication data, or report a conflict.

## 8. Standard Schedule Import

File:

```text
src/server/repositories/schedule-imports.repository.ts
```

Remove snapshot candidate fields:

```ts
sourceType: "VERIFIED_HISTORICAL"
sourceMetadata: {
  sourceFilename,
  sourceRowNumber,
  studentCategory
}
```

Pass only:

```ts
sourceImportGroupId: importId
```

plus the historical academic fields.

Do not duplicate import metadata into the snapshot. The import group remains the source of truth for filename, import mode, category, accepted time, creator, and import identity.

## 9. First-Year / OVPSA Schedule Import

File:

```text
src/server/services/first-year-schedule-import.service.ts
```

Remove:

```ts
sourceType: "OVPSA_PUBLICATION"
```

and duplicate snapshot `sourceMetadata`.

Keep:

```ts
sourceImportGroupId: importId
```

The corresponding `schedule_import_groups` row already uses `import_mode = FIRST_YEAR_OVPSA`.

Reports must treat an OVPSA-created snapshot exactly like any other valid academic snapshot.

## 10. Historical Report Domain Model

File:

```text
src/lib/historical-compliance-report.ts
```

Delete:

```ts
HistoricalDataQuality
historicalDataQualityLabel()
```

Remove:

```ts
dataQuality?: HistoricalDataQuality
```

from `HistoricalReportFilters`.

Delete the `dataQualities` set and parsing of `input.dataQuality`.

Compliance classification logic must remain unchanged:

```text
COMPLIED
PENDING_COMPLIANCE
DID_NOT_COMPLY_LABORATORY
DID_NOT_COMPLY_PHYSICAL_EXAM
DID_NOT_COMPLY_BOTH
```

## 11. Historical Compliance Repository

File:

```text
src/server/repositories/historical-compliance-report.repository.ts
```

Remove `dataQuality` from `HistoricalComplianceReportItem`.

Remove `migratedIncomplete` from `HistoricalComplianceSummary`.

Remove filtering by `filters.dataQuality`.

Remove:

```sql
snapshot.source_type AS "dataQuality"
```

from reporting rows.

Remove `dataQuality` from detailed JSON objects.

Remove the migrated-incomplete summary count.

No report SQL should reference `source_type`, `dataQuality`, or `MIGRATED_INCOMPLETE` after this change.

## 12. Reports Query URL Handling

Files include:

```text
src/components/reports/report-query.ts
src/lib/historical-report-redirect.ts
```

Remove all support for `dataQuality` from:

- URL generation
- filter persistence
- redirects
- query normalization

Because this feature has never been deployed, backward compatibility for old Data Quality URLs is unnecessary.

If a stale manually constructed URL contains `?dataQuality=...`, the parameter may simply be ignored. Do not create compatibility aliases.

## 13. Reports UI

### Filters

File:

```text
src/components/reports/ReportFilters.tsx
```

Remove:

```text
Data quality
Any data quality
Verified Historical
Recovered Historical
Migrated - Incomplete Historical Data
```

Remaining filters:

- Academic year
- Student name or number
- Overall compliance
- Laboratory status
- Physical Examination status
- College
- Program
- Year level
- Sort

### Detailed table

File:

```text
src/components/reports/ReportRecordsTable.tsx
```

Remove the Data Quality header, cells, badges, and label imports.

Target columns:

```text
Student
Historical college
Historical program
Year
Laboratory
Physical Examination
Overall
```

Adjust table width if necessary.

### Summary cards

File:

```text
src/components/reports/ReportSummaryCards.tsx
```

Remove `Migrated or incomplete historical`.

Do not replace it with another provenance statistic.

### Reports page

File:

```text
src/app/(dashboard)/reports/page.tsx
```

Remove the conditional historical-data warning based on `report.summary.migratedIncomplete`.

## 14. PDF Report

Files include:

```text
src/lib/historical-compliance-pdf.ts
src/server/reports/historical-compliance-pdf-renderer.ts
```

Remove Data Quality from:

- applied filters
- detailed rows
- table columns
- summary text

Remove `Migrated/incomplete history` from the summary.

Reallocate the freed PDF width to useful fields such as Student, Historical Program, or Overall Status. Do not leave blank layout space.

PDF semantics otherwise remain unchanged.

## 15. Reports Acceptance Fixture

File:

```text
scripts/browser-reports-acceptance-fixture.ts
```

Remove artificial cycling among:

```text
VERIFIED_HISTORICAL
RECOVERED_HISTORICAL
MIGRATED_INCOMPLETE
```

Do not create fake incomplete-migration students.

All fixture snapshots must reference valid fixture `schedule_import_groups`.

Prefer including at least one `STANDARD` import group and one `FIRST_YEAR_OVPSA` import group.

The acceptance fixture must prove both publication modes use the same Reports contract without special Data Quality behavior.

## 16. Test-Fixture Architecture

Search the repository for:

```text
INSERT INTO student_academic_snapshots
```

Update every affected test/fixture for the new required FK.

Do not solve this by making `source_import_group_id` nullable or disabling the FK.

Where many tests manually create snapshots, use or add a focused integration-test helper that creates a valid schedule import group and returns its ID.

Prefer explicit fixture steps:

```text
create test academic year
create test import group
create snapshot linked to import group
```

## 17. Migration Tests

The existing file:

```text
src/server/db/reports-historical-compliance-migration.integration.test.ts
```

is largely built around legacy recovery behavior.

Remove tests for:

- recovered historical rows
- current-profile fallbacks
- `RECOVERED_HISTORICAL`
- `MIGRATED_INCOMPLETE`
- source-type validation
- historical migration totals
- automatically derived academic years
- `HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED`

Preserve valuable schema/invariant tests by rewriting or moving them.

Required migration/schema tests:

1. migration 016 creates `academic_years`;
2. migration 016 creates `student_academic_snapshots`;
3. snapshot updates are rejected;
4. snapshot deletes are rejected;
5. duplicate `(student_number, academic_year_start)` rows are rejected;
6. `source_import_group_id` is required;
7. invalid/nonexistent import-group IDs are rejected by FK;
8. migration 016 does not generate academic years from appointment data;
9. migration 016 does not generate snapshots automatically.

Rename the test if the old historical-migration name becomes misleading, for example:

```text
reports-academic-snapshot-schema.integration.test.ts
```

## 18. Snapshot Repository Tests

File:

```text
src/server/repositories/student-academic-snapshots.repository.integration.test.ts
```

Required tests:

### Creates a snapshot

A candidate with a valid import group creates one snapshot.

### Idempotent identical import

Calling the gateway again for the same student/year with identical academic information must not create a duplicate.

### Academic conflict

Changing a historical academic field for the same student/year must return/report `CONFLICT`.

### Immutability

Stored historical snapshot values cannot be modified or deleted.

### Provenance

The created snapshot's `source_import_group_id` equals the import that first created it.

### Repeat import provenance

If a later import group submits identical academic information for the same student/year:

- do not create another snapshot;
- do not overwrite the original `source_import_group_id`;
- do not classify this as a historical-data-quality issue.

## 19. Standard Import Integration Tests

Update:

```text
src/server/services/schedule-imports.integration.test.ts
```

Required assertions:

1. standard publication creates snapshots;
2. every created snapshot has the standard import group's ID;
3. snapshot academic information matches imported information;
4. the snapshot has no `source_type`;
5. the snapshot has no `source_metadata`;
6. subsequent profile changes do not rewrite the historical snapshot;
7. existing snapshot conflict semantics remain intact.

## 20. First-Year / OVPSA Integration Tests

Update relevant tests including:

```text
src/server/services/first-year-schedule-import.integration.test.ts
src/server/db/first-year-schedule-import-consolidation-migration.integration.test.ts
```

and associated browser fixtures.

Assert:

1. First-Year scheduling creates an ordinary academic snapshot;
2. `source_import_group_id` points to the First-Year import group;
3. the import group's `import_mode` is `FIRST_YEAR_OVPSA`;
4. Reports returns the student normally;
5. no Data Quality label is required;
6. no undefined/blank Reports value occurs;
7. OVPSA appointment/displacement event causes continue functioning.

## 21. Reports Tests

Update report-related tests including:

```text
src/lib/historical-compliance-report.test.ts
src/server/repositories/historical-compliance-report.repository.integration.test.ts
src/app/(dashboard)/reports/page.test.tsx
src/lib/historical-compliance-pdf.test.ts
src/server/reports/historical-compliance-pdf-renderer.test.ts
src/app/api/reports/export/pdf/route.test.ts
src/server/acceptance/browser-reports-acceptance-fixture.test.ts
```

Also update old `/appointments` and `/compliance` redirect tests if they contain `dataQuality`.

Tests must no longer construct objects containing `dataQuality` or summaries containing `migratedIncomplete`.

## 22. Documentation Cleanup

The old design document:

```text
docs/superpowers/specs/2026-08-02-reports-historical-compliance-design.md
```

must not remain ambiguous about the current architecture.

Add a clear supersession notice stating that before first production deployment:

- historical migration recovery was removed;
- user-facing Data Quality was removed;
- snapshots now originate from authoritative import groups;
- the immutable academic snapshot model remains.

Do the same for the corresponding old implementation plan if future maintainers could mistake it for the current design:

```text
docs/superpowers/plans/2026-08-02-reports-historical-compliance.md
```

Git history already preserves the original design, so current documentation should describe the current system.

## 23. Anti-Spaghetti Architecture Rules

### One source of truth

Do not store import mode both in `schedule_import_groups` and `student_academic_snapshots`.

Use the import-group relationship.

### Reports must not know publication implementation details

Reports should consume:

```text
academic snapshot
+
effective appointments
+
academic-year state
```

It must not care whether the snapshot came from `STANDARD` or `FIRST_YEAR_OVPSA`.

### No compatibility layer for an undeployed feature

Do not introduce abstractions such as:

```text
legacyDataQuality
deprecatedSourceType
migrationCompatibility
normalizeOldSource
```

There is no production history to preserve.

### No corrective migration layer

Do not create a new migration whose only purpose is to undo unused source types from the pre-production migration chain.

### Keep modules focused

- Snapshot repository: snapshot persistence and conflict protection
- Reports repository: historical compliance reporting
- Schedule imports: authoritative publication
- OVPSA service: First-Year scheduling and publication

Do not move unrelated scheduling logic into Reports or snapshot code.

### No unsafe type casts

Remove casts such as:

```ts
row.dataQuality as HistoricalDataQuality
```

rather than replacing them with another cast.

Database result types and domain types must agree naturally.

## 24. Hidden-Bug Regression Requirement

This cleanup must eliminate the current class of bug where a valid database snapshot source exists but the Reports type system does not know how to display it.

After implementation it must be impossible for Reports to produce:

```text
undefined
blank badge
unknown Data Quality
unsupported snapshot source type
```

because Reports no longer consumes snapshot source classifications.

Target relationship:

```text
schedule_import_groups
        │
        │ provenance
        ▼
student_academic_snapshots
        │
        │ historical academic facts
        ▼
Reports
```

## 25. Repository-Wide Cleanup Search

Before completion, search for:

```text
VERIFIED_HISTORICAL
RECOVERED_HISTORICAL
MIGRATED_INCOMPLETE
HistoricalDataQuality
historicalDataQualityLabel
migratedIncomplete
dataQuality
HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED
CURRENT_PROFILE_FALLBACK
ACCEPTED_IMPORT_GROUP_RECOVERY
CURRENT_PROFILE_AT_LEGACY_PUBLICATION
```

There should be no executable/runtime dependency on them.

Historical text may remain only where intentionally documenting the superseded architecture.

Also search snapshot-specific code for:

```text
source_type
source_metadata
```

Do not globally remove those names from unrelated domains such as email/notification tables.

### OVPSA exception

`OVPSA_PUBLICATION` is allowed to remain in legitimate OVPSA appointment lifecycle/reschedule-event logic.

Verify only that it is no longer used as a student academic snapshot source.

## 26. Required Verification

Run at minimum:

```bash
npm run lint
npm test
npm run test:migrations:empty
npm run build
```

The empty-database migration test is particularly important because the migration chain is being corrected.

For a disposable local database, also verify a complete reset/rebuild using the repository's `db:reset` workflow.

The rebuilt schema must successfully apply migrations `001` through the latest migration and then apply seeds without depending on pre-existing appointment history.

## 27. Fresh-Database Acceptance Scenario

Initial database:

```text
no students
no appointments
no academic snapshots
no academic years
no historical records
```

Expected workflow:

```text
Admin configures academic year
          ↓
Coordinator imports student CSV
          ↓
Import group is created
          ↓
Schedules are generated/published
          ↓
Immutable academic snapshots are created
          ↓
Lab/PE appointment lifecycle occurs
          ↓
Reports read historical snapshot + appointments
```

At no point should the system attempt to:

```text
recover old appointments
infer old academic-year owners
fallback to a current profile for history
mark historical data incomplete
classify historical provenance quality
```

## 28. Reports Acceptance Scenario

Given:

```text
Student A → STANDARD import
Student B → FIRST_YEAR_OVPSA import
```

and both have valid snapshots and published appointments, Reports must display both using the same row model:

```text
Student
Historical college
Historical program
Year
Laboratory
Physical Examination
Overall
```

There must be:

```text
no Data Quality column
no migration warning
no provenance badge
no blank label
no special-case OVPSA rendering
```

## 29. PDF Acceptance Scenario

The PDF must include:

- academic year
- closing date/state
- report summary
- compliance breakdowns
- current filters
- detailed compliance records

The PDF must not contain:

```text
Data Quality
Verified Historical
Recovered Historical
Migrated - Incomplete Historical Data
Migrated/incomplete history
```

## 30. Definition of Done

The change is complete only when all of the following are true:

1. `student_academic_snapshots` remains immutable.
2. One snapshot exists at most once per student and academic year.
3. Every snapshot references a valid schedule import group.
4. Snapshot source type has been removed.
5. Snapshot source metadata has been removed.
6. Legacy historical-recovery SQL has been removed from migration 016.
7. Migration 016 no longer auto-generates historical academic years.
8. Migration 019 no longer alters snapshot source-type constraints.
9. Standard imports create valid snapshots.
10. First-Year/OVPSA imports create valid snapshots.
11. Reports do not expose Data Quality.
12. Reports do not filter by Data Quality.
13. Reports summary does not expose migrated/incomplete counts.
14. Reports repository has no Data Quality branch.
15. Reports PDF contains no Data Quality concepts.
16. Old report redirects contain no Data Quality behavior.
17. Historical-recovery helper/dead code has been deleted.
18. No unsafe cast is used to hide a snapshot/report type mismatch.
19. Tests use valid import-group-backed snapshots.
20. Empty-database migration verification passes.
21. Lint passes.
22. Full tests pass.
23. Production build passes.
24. A fresh database can reach the Reports workflow without legacy records.
25. Existing OVPSA appointment lifecycle behavior still passes regression tests.

## 31. Explicit Non-Goals

Do not modify:

- scheduling capacity rules;
- Laboratory-before-Physical-Examination rules;
- appointment displacement semantics;
- clinic closure recovery policy;
- status buttons;
- student results uploads;
- authentication;
- email notifications;
- staff permissions;
- compliance classification rules;
- academic-year closing-state rules;
- OVPSA operational event causes.

Only make changes required to simplify historical snapshot provenance and Reports.

## 32. Implementation Principle

The final system should be explainable with one sentence:

> When a schedule is authoritatively published, the system stores one immutable copy of the student's academic information for that academic year, links that snapshot to the import that created it, and Reports uses the snapshot together with the student's final effective appointments to calculate historical compliance.

If the resulting implementation requires explaining recovered historical records, migrated incomplete records, Data Quality classifications, or OVPSA-specific report rendering, the cleanup is incomplete.
