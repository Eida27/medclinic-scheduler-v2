# Reports and Historical Compliance Implementation Plan

> **Superseded:** This plan is replaced by the [2026-09-01 Reports Data-Quality and Historical-Migration Cleanup design](../specs/2026-09-01-reports-data-quality-cleanup-design.md) and its [2026-09-02 implementation plan](./2026-09-02-reports-data-quality-cleanup.md). The current architecture removes pre-deployment historical recovery and user-facing Data Quality, uses schedule import groups as the only snapshot provenance, and retains immutable historical academic snapshots.

**Goal:** Replace the administrator Appointments summary with an immutable, academic-year-scoped historical compliance report and filtered PDF export while preserving all operational appointment workflows.

**Source design:** `docs/superpowers/specs/2026-08-02-reports-historical-compliance-design.md`

**Branch/worktree:** `codex/reports-historical-compliance` in `.worktrees/reports-historical-compliance`

**Method:** Execute each task with red-green-refactor, a focused verification run, and a task-level review gate. Finish with a fresh full verification and Browser acceptance. Do not merge or push automatically.

## Task 1: Schema, migration, and immutable snapshot gateway

- Add a database migration for `academic_years` and `student_academic_snapshots`.
- Derive academic-year labels from `start_year`, backfill existing cycles with July 31 of `startYear + 1`, and add reporting indexes.
- Enforce the snapshot source classifications and database-level immutability, including duplicate-conflict rejection.
- Recover snapshot history only from qualifying published import groups whose evidence has not been invalidated by later student or reference changes. Mark all other fallbacks `MIGRATED_INCOMPLETE`.
- Record migration totals and provenance in audit metadata.
- Add one bulk snapshot gateway shared by migration, direct schedule imports, and legacy batch publication.
- Compare every immutable academic field before current-profile upserts. Identical data is idempotent; conflicts commit `SNAPSHOT_CONFLICT_DETECTED` but publish no student or appointment changes.
- Require a configured academic year before future imports.
- Add focused schema, migration, gateway, direct-import, and batch-publication tests.

## Task 2: Academic-year administration

- Add an academic-year repository and service with derived labels and Asia/Manila state calculation.
- Define `OPEN`, `CLOSING_SOON`, and `CLOSED`; closing soon begins 14 calendar days before closing.
- Add administrator-only `GET`, `POST`, `PATCH`, and `DELETE /api/settings/academic-years`.
- Validate closing dates within August 1 through July 31 of the labeled cycle.
- Audit creates, closing-date updates, and deletes; prevent deletion when snapshots are linked.
- Build `/settings/academic-years` with create/edit controls, state badges, linked-record counts, conflict-safe feedback, and an administrator sidebar link.
- Add focused unit, service, route, page, and audit tests.

## Task 3: Historical report model and repository

- Add a shared report query parser for `academicYearStart`, `search`, `overallStatus`, `laboratoryStatus`, `physicalExamStatus`, `collegeId`, `programId`, `yearLevel`, `dataQuality`, `sort`, and `page`.
- Use 150 rows per page and `college_asc` as the default deterministic sort.
- Add the academic-year state helper, compliance classifier, and display-label helpers.
- Build a dedicated report repository query scoped by `schedule_cycle_start`, immutable snapshots, and published leaf/effective appointments.
- Materialize the filtered rows once per query so detail rows, totals, and college/program/year breakdowns reconcile.
- Include inactive students and graduates; use historical snapshot dimensions and labels for all filters and display.
- Classify incomplete open-year records as `PENDING_COMPLIANCE`; classify closed-year records by the missing requirement or both.
- Cover snapshot stability, yearly differences, replacement precedence, unpublished and superseded exclusion, filters, deterministic sorts, reconciliation, and the 150/151 pagination boundary.

## Task 4: Reports UI, access, and redirects

- Build administrator-only `/reports` with the Executive Summary layout: required-year prompt, academic-year header, primary/secondary metrics, grouped breakdown links, dependent college/program filters, warnings, detailed records, sorting, and URL-preserving pagination.
- Keep export disabled while the year is missing or the result set is empty and preserve filters when export errors are shown.
- Show Reports only to administrators and remove Appointments from every sidebar variant.
- Redirect only the `/appointments` index and `/compliance` to `/reports`, mapping compatible legacy parameters and preserving the dynamic appointment-detail route and operational APIs.
- Add `/reports/:path*` to authenticated proxy matching.
- Test role access, navigation visibility, required and unknown years, redirects, empty states, filters, sorting, and pagination.

## Task 5: PDF export

- Add `pdfkit@0.19.1` and `@types/pdfkit@0.17.6`; externalize PDFKit as a Node-only server package.
- Add an administrator-only `GET /api/reports/export/pdf` using the normalized report filters and sort.
- Reject a 10,001st matching row before response bytes are emitted.
- Stream a landscape PDF containing provenance, applied filters, reconciled summaries and breakdowns, all filtered rows, repeated table headers, and academic-year/page footers.
- Return an ASCII-safe dated filename and audit the actor, filters, sort, row count, generation time, and outcome.
- Add unit and route tests for the filename, document model, PDF headers, all-row export, repeated multi-page headers, empty results, authorization, and oversized rejection.

## Task 6: Guarded Browser fixture and acceptance

- Add a loopback-only, cleanup-capable reports fixture with open and closed years, all snapshot quality classes, replacement appointments, inactive students, and deliberately divergent current and historical profile labels.
- Verify in the requested in-app Browser: administrator navigation and academic-year CRUD; non-admin link absence and direct denial; required-year prompt; open/closed classification; stable historical labels; breakdown links; dependent filters; URL refresh/bookmark state; sorting; pagination; empty states; PDF download; redirects; desktop/tablet layouts; network behavior; and a clean console.
- Remove all fixture residue and verify cleanup.

## Final review and verification

- Run task-level Superpowers reviews, then a final implementation review and one bounded fix/re-review wave if required.
- Run fresh verification from the feature worktree:

```powershell
npm test -- --run --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000
npm run lint
npm run build
```

- Repeat the Browser acceptance after the final code review and clean up fixtures.
- Preserve `codex/reports-historical-compliance` and its worktree. Present the standard local-merge, pull-request, or keep-as-is choices; do not merge or push without the user's selection.
