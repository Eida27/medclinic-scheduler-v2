# Reports Data-Quality Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the undeployed historical-migration/Data Quality subsystem while retaining immutable, import-group-backed academic snapshots and unchanged historical-compliance behavior.

**Architecture:** `schedule_import_groups` is the sole provenance source for snapshots: every `student_academic_snapshots` row references the authoritative import group that first created it. Reports consume historical academic facts plus effective appointments and never branch on publication provenance. Migrations 016 and 019 are corrected in place because production will start from an empty database.

**Tech Stack:** Next.js App Router, React, TypeScript, PostgreSQL migrations/functions, Vitest, React PDF, authenticated browser acceptance, Poppler PDF inspection.

**Spec:** `docs/superpowers/specs/2026-09-01-reports-data-quality-cleanup-design.md`

## Global Constraints

- Work only on branch `codex/reports-data-quality-cleanup` in `.worktrees/reports-data-quality-cleanup`; preserve the worktree after verification and do not merge or push.
- Use strict red-green-refactor cycles. Every behavioral implementation follows an observed failing focused test.
- Use only the uniquely named disposable PostgreSQL database derived from the local connection. Never reset `medclinic_scheduler` or any shared/production database.
- Rewrite the pre-deployment migration chain; do not add a corrective migration or a compatibility layer.
- Keep compliance classification, effective-appointment rules, historical dimensions, access control, filtering other than Data Quality, sorting, breakdowns, pagination, audit behavior, notification behavior, scheduling rules, and academic-year closing behavior unchanged.
- Retain `OVPSA_PUBLICATION` wherever it is an operational lifecycle/displacement cause; remove it only as snapshot provenance.
- Remove Data Quality without replacing it with import mode, provenance, source type, or any other report field.
- Every direct test/fixture snapshot insert must reference a schema-valid `STANDARD` or `FIRST_YEAR_OVPSA` import group.
- The Reports fixture must contain four deterministic import groups, 153 students, 157 snapshots, 165 appointments, and 150+3 pagination; cleanup must prove zero residue including import groups and export audits.
- The detail UI has exactly seven columns and `min-width: 64rem`.
- The PDF detail widths total 724 points exactly: Student 132, Historical College 98, Historical Program 154, Year 40, Laboratory 92, Physical Examination 92, Overall 116.

---

### Task 1: Migration and Schema Contract

**Files:**
- Modify: `database/migrations/016_reports_historical_compliance.sql`
- Modify: `database/migrations/019_first_year_ovpsa_priority_scheduling.sql`
- Rename: `src/server/db/reports-historical-compliance-migration.integration.test.ts` to `src/server/db/reports-academic-snapshot-schema.integration.test.ts`
- Modify: `src/server/db/first-year-ovpsa-priority-scheduling-migration.integration.test.ts`
- Modify: `src/server/db/first-year-schedule-import-consolidation-migration.integration.test.ts`

**Interfaces:**
- Consumes: existing `schedule_import_groups(id)` from migrations 012/020 and migration test helpers.
- Produces: `student_academic_snapshots.source_import_group_id UUID NOT NULL REFERENCES schedule_import_groups(id) ON DELETE RESTRICT`, index `student_academic_snapshots_source_import_group_idx`, and `ensure_student_academic_snapshots(p_candidates JSONB, p_actor VARCHAR)` accepting only academic fields plus `source_import_group_id`.

- [ ] **Step 1: Write the schema tests first**

  Rename and rewrite the migration integration test to assert table creation; absence of `source_type` and `source_metadata`; non-null and valid import-group FK; `ON DELETE RESTRICT`; source index presence; unique `(student_number, academic_year_start)`; immutable update/delete; and no academic-year/snapshot creation from appointments that predate migration 016. Add regression assertions that migration 019 contains no snapshot source-type constraint while OVPSA lifecycle cause constraints remain valid.

- [ ] **Step 2: Run the focused tests and observe RED**

  ```powershell
  npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=verbose src/server/db/reports-academic-snapshot-schema.integration.test.ts src/server/db/first-year-ovpsa-priority-scheduling-migration.integration.test.ts src/server/db/first-year-schedule-import-consolidation-migration.integration.test.ts
  ```

  Expected: failures identify nullable/missing FK/index, legacy columns/recovery behavior, and migration 019's obsolete source-type block.

- [ ] **Step 3: Implement the minimum migration rewrite**

  Define the table provenance column as:

  ```sql
  source_import_group_id UUID NOT NULL
    REFERENCES schedule_import_groups(id)
    ON DELETE RESTRICT
  ```

  Add `student_academic_snapshots_source_import_group_idx`; remove `source_type`, `source_metadata`, source-type checks, appointment-derived recovery CTEs, fallback snapshot generation, and `HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED` auditing. Keep explicit academic-year schema, immutable triggers, uniqueness, conflict auditing, and conflict comparison of only the seven historical academic fields. Remove only migration 019's snapshot classification block.

- [ ] **Step 4: Rebuild and verify GREEN on the disposable database**

  Run `npm.cmd run db:reset` with `ALLOW_DB_RESET=true` and `DATABASE_URL` overridden to the unique disposable database, then rerun the focused tests. Verify migrations 001-027 and seeds apply from empty state.

- [ ] **Step 5: Self-review and commit**

  Confirm no automatic historical recovery remains and no unrelated OVPSA cause was removed. Commit as `refactor(db): require import-backed academic snapshots`.

---

### Task 2: Canonical Snapshot Publication

**Files:**
- Modify: `src/server/repositories/student-academic-snapshots.repository.ts`
- Modify: `src/server/repositories/student-academic-snapshots.repository.integration.test.ts`
- Modify: `src/server/repositories/schedule-imports.repository.ts`
- Modify: `src/server/services/schedule-imports.integration.test.ts`
- Modify: `src/server/services/first-year-schedule-import.service.ts`
- Modify: `src/server/services/first-year-schedule-import.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's JSON gateway and required import-group FK.
- Produces:

  ```ts
  export interface StudentAcademicSnapshotCandidate {
    studentNumber: string;
    academicYearStart: number;
    studentName: string;
    collegeId: string;
    collegeName: string;
    programId: string;
    programCode: string;
    programName: string;
    yearLevel: number;
    sourceImportGroupId: string;
  }
  ```

  `ensureStudentAcademicSnapshotsWithClient(client, candidates, actor)` remains the single publication gateway. `StudentAcademicSnapshotSource`, `sourceType`, `sourceMetadata`, `BatchSnapshotRow`, and `ensureBatchStudentAcademicSnapshotsWithClient` do not remain.

- [ ] **Step 1: Write failing gateway/publication tests**

  Cover creation, identical idempotence, historical-field conflict, immutable update/delete, original import ID retention, identical later publication from a different group, Standard import provenance/profile stability, and First-Year provenance/import mode/unchanged displacement behavior. Assert the stored table has no legacy columns.

- [ ] **Step 2: Run focused tests and observe RED**

  ```powershell
  npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=verbose src/server/repositories/student-academic-snapshots.repository.integration.test.ts src/server/services/schedule-imports.integration.test.ts src/server/services/first-year-schedule-import.integration.test.ts
  ```

- [ ] **Step 3: Refactor the snapshot gateway and both publishers**

  Serialize only the historical fields and `source_import_group_id`. Standard publication passes `sourceImportGroupId: importId`; First-Year/OVPSA does the same and relies on the group's `import_mode = FIRST_YEAR_OVPSA`. Preserve notification/audit `sourceType` properties and operational `OVPSA_PUBLICATION` causes outside snapshot persistence.

- [ ] **Step 4: Run focused GREEN and adjacent regressions**

  Rerun the three focused files and the First-Year consolidation migration regression. Verify profile edits do not rewrite history and existing displacement semantics pass.

- [ ] **Step 5: Self-review and commit**

  Confirm the first successful group remains authoritative for identical later imports. Commit as `refactor(reports): canonicalize snapshot publication provenance`.

---

### Task 3: Test and Acceptance Fixtures

**Files:**
- Modify: `src/test/integration-fixtures.ts`
- Modify: every executable test/fixture returned by `rg -l "INSERT INTO student_academic_snapshots" src scripts`
- Modify: `scripts/browser-reports-acceptance-fixture.ts`
- Modify: `src/server/acceptance/browser-reports-acceptance-fixture.test.ts`
- Modify: affected Standard, First-Year, clinic-calendar, external-laboratory, academic-year, and shared cleanup fixtures.

**Interfaces:**
- Consumes: Task 1's required FK and Task 2's canonical publication model.
- Produces:

  ```ts
  insertTestScheduleImportGroup(client, {
    name,
    sourceFilename,
    academicYearStart,
    importMode: "STANDARD" | "FIRST_YEAR_OVPSA",
    id?,
    acceptedAt?,
    actor,
  }): Promise<string>
  ```

  Reports fixture status exposes and verifies exactly `importGroups: 4`; cleanup removes snapshots before groups and reports zero rows for every fixture-owned table/audit.

- [ ] **Step 1: Write failing helper and fixture-contract tests**

  Test valid Standard/First-Year group creation, four deterministic Reports groups, correct student-to-mode mapping for `B-RPT-0001` and `B-RPT-0002`, preserved counts (153/157/165), readiness/status tracking, collision protection, and zero-residue cleanup.

- [ ] **Step 2: Run focused fixture tests and observe RED**

  ```powershell
  npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=verbose src/server/acceptance/browser-reports-acceptance-fixture.test.ts
  ```

- [ ] **Step 3: Implement the focused helper and update all direct inserts**

  Create schema-valid group metadata for only `STANDARD` and `FIRST_YEAR_OVPSA`; reference returned IDs from each snapshot. Reorder every affected cleanup so immutable snapshots are deleted before their import groups. Do not relax the FK or disable constraints.

- [ ] **Step 4: Refactor the Reports fixture**

  Create Standard and First-Year groups for each of the two fixture years. Preserve 153 students, 157 snapshots, 165 appointments, and 150+3 pagination. Remove artificial data-quality cycling; status and cleanup must own and count all four groups and exported-report audits.

- [ ] **Step 5: Run GREEN, self-review, and commit**

  Rerun the focused fixture test plus all modified integration files. Commit as `test: use import-backed academic snapshot fixtures`.

---

### Task 4: Reports Domain, Repository, URLs, and UI

**Files:**
- Modify: `src/lib/historical-compliance-report.ts`
- Modify: `src/lib/historical-compliance-report.test.ts`
- Modify: `src/server/repositories/historical-compliance-report.repository.ts`
- Modify: `src/server/repositories/historical-compliance-report.repository.integration.test.ts`
- Modify: `src/components/reports/report-query.ts` and tests
- Modify: `src/lib/historical-report-redirect.ts` and tests
- Modify: `src/components/reports/ReportFilters.tsx`
- Modify: `src/components/reports/ReportRecordsTable.tsx`
- Modify: `src/components/reports/ReportSummaryCards.tsx`
- Modify: `src/app/(dashboard)/reports/page.tsx` and tests

**Interfaces:**
- Consumes: snapshots as historical facts only; no provenance classification.
- Produces: `HistoricalReportFilters`, report items, and summaries with neither `dataQuality` nor `migratedIncomplete`. Canonical query/redirect URLs silently omit any stale `dataQuality` parameter.

- [ ] **Step 1: Write failing domain, repository, URL, redirect, and component tests**

  Prove valid and arbitrary stale Data Quality inputs are ignored; canonical URLs and legacy redirects omit them; objects contain neither removed property; no control, warning, badge, table column, or summary card is rendered; and the detail header is exactly Student, Historical college, Historical program, Year, Laboratory, Physical Examination, Overall.

- [ ] **Step 2: Run focused tests and observe RED**

  ```powershell
  npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=verbose src/lib/historical-compliance-report.test.ts src/server/repositories/historical-compliance-report.repository.integration.test.ts src/app/(dashboard)/reports/page.test.tsx
  ```

  Add the exact query/redirect/component test paths discovered in the repository to the same run.

- [ ] **Step 3: Remove Data Quality end to end**

  Delete types, labels, parsing sets, SQL selection/filtering, JSON fields, unsafe casts, summary counts, query persistence, redirects, filters, warnings, badges, the eighth column, and the summary card. Set the seven-column table minimum width to `64rem`. Leave compliance and effective-appointment logic byte-for-byte or semantically unchanged except where type cleanup requires edits.

- [ ] **Step 4: Run focused GREEN and React quality review**

  Rerun all touched test files. Apply the `vercel:react-best-practices` checklist to each modified TSX component and fix only findings within this task's scope.

- [ ] **Step 5: Self-review and commit**

  Confirm stale parameters normalize away and no replacement provenance is exposed. Commit as `refactor(reports): remove data quality surfaces`.

---

### Task 5: PDF Contract and Layout

**Files:**
- Modify: `src/lib/historical-compliance-pdf.ts`
- Modify: `src/lib/historical-compliance-pdf.test.ts`
- Modify: `src/server/reports/historical-compliance-pdf-renderer.ts`
- Modify: `src/server/reports/historical-compliance-pdf-renderer.test.ts`
- Modify: `src/app/api/reports/export/pdf/route.test.ts`

**Interfaces:**
- Consumes: Task 4's provenance-free report item, summary, and filters.
- Produces: PDF detail columns `{ student: 132, college: 98, program: 154, year: 40, laboratory: 92, physicalExamination: 92, overall: 116 }`, totaling 724 points.

- [ ] **Step 1: Write failing model, renderer, and route tests**

  Assert required sections remain; filenames, authorization, row limits, repeat headers, pagination, audit behavior, and ASCII safety remain; retired labels and properties are absent; and widths total exactly 724 points with the specified allocation.

- [ ] **Step 2: Run focused tests and observe RED**

  ```powershell
  npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=verbose src/lib/historical-compliance-pdf.test.ts src/server/reports/historical-compliance-pdf-renderer.test.ts src/app/api/reports/export/pdf/route.test.ts
  ```

- [ ] **Step 3: Remove PDF Data Quality and reallocate layout**

  Remove the applied filter, detail property/column, and migrated-history summary line. Apply the exact seven widths; leave no blank cell or unused content width.

- [ ] **Step 4: Run focused GREEN, self-review, and commit**

  Rerun the three focused files. Confirm all existing PDF semantics except retired provenance are preserved. Commit as `refactor(reports): simplify historical compliance pdf`.

---

### Task 6: Documentation, Repository Cleanup, and Acceptance

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-reports-historical-compliance-design.md`
- Modify: `docs/superpowers/plans/2026-08-02-reports-historical-compliance.md`
- Modify only executable files found by the retirement search when a snapshot-specific dependency remains.

**Interfaces:**
- Consumes: Tasks 1-5 complete, reviewed behavior.
- Produces: current documentation with explicit supersession links, zero executable dependencies on retired symbols, a fully verified fresh-database/browser/PDF acceptance result, and zero fixture residue.

- [ ] **Step 1: Add supersession notices**

  Link both old documents to `docs/superpowers/specs/2026-09-01-reports-data-quality-cleanup-design.md` and this plan. State that pre-deployment recovery and user-facing Data Quality were removed, import groups are the only provenance, and immutable historical snapshots remain.

- [ ] **Step 2: Run bounded retirement searches and remove remaining executable dependencies**

  Search executable code for `VERIFIED_HISTORICAL`, `RECOVERED_HISTORICAL`, `MIGRATED_INCOMPLETE`, `HistoricalDataQuality`, `historicalDataQualityLabel`, `migratedIncomplete`, `dataQuality`, `HISTORICAL_SNAPSHOT_MIGRATION_EXECUTED`, `CURRENT_PROFILE_FALLBACK`, `ACCEPTED_IMPORT_GROUP_RECOVERY`, and `CURRENT_PROFILE_AT_LEGACY_PUBLICATION`. Inspect every snapshot-specific `source_type`/`source_metadata`. Allow those SQL names only in unrelated domains and allow `OVPSA_PUBLICATION` only for operational lifecycle causes.

- [ ] **Step 3: Run fresh database and full source verification**

  Against the uniquely named disposable database only, run:

  ```powershell
  npm.cmd run db:reset
  npm.cmd test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=dot
  npm.cmd run test:migrations:empty
  npm.cmd run lint
  npm.cmd run build
  git diff --check
  ```

  Set `ALLOW_DB_RESET=true` only for the first command and prove migrations 001-027 plus seeds succeed.

- [ ] **Step 4: Run guarded authenticated Browser acceptance**

  Set up the Reports fixture against the disposable database, start the app against that same database, and verify `B-RPT-0001` and `B-RPT-0002` use the same seven-column contract. Exercise historical labels, open/closed classifications, filters, sorting, 150+3 pagination, stale-parameter normalization, legacy redirects, desktop/tablet layout, and PDF export. Require successful relevant requests and a clean browser console. If no usable authenticated Browser session exists, record acceptance as unavailable and do not claim it passed.

- [ ] **Step 5: Inspect the exported PDF visually**

  Copy the download to `tmp/pdfs/reports-data-quality-cleanup/`; inspect metadata and extracted text; render every page with Poppler; visually check typography, widths, wrapping, repeated headers, footers, page numbers, clipping, overlap, blank columns, and absence of retired wording.

- [ ] **Step 6: Prove zero fixture residue**

  Run fixture status and cleanup and require zero owned students, snapshots, appointments, four import groups, related configuration, and exported-report audit rows.

- [ ] **Step 7: Commit documentation/cleanup**

  Commit as `docs: supersede reports data quality architecture`.

- [ ] **Step 8: Final whole-branch review and one bounded fix/re-review wave**

  Review the complete branch against the design, this plan, and all global constraints. Resolve only concrete findings and re-run their focused tests plus affected acceptance. Preserve the branch/worktree for user review; do not merge, push, or delete it.
