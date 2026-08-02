# Reports and Historical Compliance Design

**Project:** MedClinic Scheduler V2  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Date:** 2026-08-02  
**Status:** Approved design; implementation planning pending

## 1. Purpose

Replace the current **Appointments** tab with an administrator-only **Reports** module that provides historical academic-year compliance summaries, detailed student-level records, filtering and sorting by academic structure, and PDF export.

The Reports module must preserve the college, course, and year-level information that applied to each student during the selected academic year. Reports must not change later when a student's current profile or the reference catalog changes.

## 2. Approved Product Decisions

1. Historical reports use an academic-year snapshot of the student's college, course, and year level.
2. A student is classified as **Did Not Comply** only after the relevant academic year has closed and either the Laboratory or Physical Examination requirement is not completed.
3. Each academic year has an administrator-configured closing date.
4. PDF exports include summary figures, grouped breakdowns, applied filters, and detailed filtered records.
5. Only administrators may view Reports or export PDFs.
6. Existing records are migrated using the best historical source available. Current-profile fallback data is visibly marked as incomplete historical data.
7. The existing `/appointments` route is replaced by `/reports`; supported old query parameters are redirected when practical.
8. The selected page layout is **Executive Summary**: summary cards, grouped academic breakdowns, filter panel, and detailed records on one page.

## 3. Scope

### In scope

- Replace the sidebar Appointments link with Reports for administrators.
- Add `/reports` with summary cards, breakdowns, filters, sorting, pagination, and detailed records.
- Add academic-year administration at `/settings/academic-years`.
- Add immutable student academic-year snapshots.
- Add best-effort migration for historical snapshots.
- Add administrator-only server-generated PDF export.
- Redirect `/appointments` to `/reports`.
- Add authorization, audit logging, validation, and automated tests.

### Out of scope

- Editing appointment statuses directly from Reports.
- Moving Laboratory or Physical Examination operational controls into Reports.
- Exposing Reports to coordinators, clinic staff, or students.
- Exporting reports to spreadsheet formats in this iteration.
- Building a separate analytics warehouse or asynchronous reporting queue.

## 4. User Experience

### 4.1 Navigation and access

- Remove **Appointments** from the primary navigation.
- Add **Reports** under administrator-visible navigation and link it to `/reports`.
- Non-administrators do not see the link.
- `/reports` and every report export endpoint independently require the `ADMIN` role.
- `/appointments` redirects to `/reports` while preserving compatible filters where possible.

### 4.2 Page header

**Title:** Reports  
**Description:** Review historical appointment compliance, identify students with incomplete requirements, and export filtered records.

The primary action is **Export PDF**. It exports every record matching the current filters, not only the visible page.

### 4.3 Required academic-year context

The selected academic year is the main reporting scope. Display:

- Academic-year label, such as `2025–2026`
- Closing date
- State: `OPEN`, `CLOSING_SOON`, or `CLOSED`

No compliance report or PDF export is generated without an academic-year selection.

### 4.4 Summary cards

Display:

1. Total Students
2. Fully Complied
3. Did Not Comply, or Pending Compliance while the year is open
4. Compliance Rate

Secondary figures:

- Laboratory incomplete
- Physical Examination incomplete
- Both incomplete
- Migrated or incomplete historical records

### 4.5 Academic breakdown

Show grouped results by:

- College
- Course or program
- Year level

Each group includes:

- Total students
- Complied students
- Pending or noncompliant students
- Compliance percentage

Selecting a college breakdown applies the corresponding college filter to the detailed report.

### 4.6 Filters

- Student name or number
- Academic year
- Overall compliance status
- Laboratory status
- Physical Examination status
- College
- Course or program
- Year level

Course options depend on the selected college. Filters are encoded in the URL so views can be refreshed or bookmarked.

### 4.7 Sorting

Support:

- College ascending or descending
- Course ascending or descending
- Year level ascending or descending
- Student name ascending or descending
- Compliance status, attention first or completed first

### 4.8 Detailed records

Each record contains:

- Student name and student number
- Historical college
- Historical course code and name
- Historical year level
- Laboratory appointment date and final effective status
- Physical Examination appointment date and final effective status
- Overall compliance classification
- Historical data-quality classification

Data-quality labels:

- `VERIFIED_HISTORICAL`
- `RECOVERED_HISTORICAL`
- `MIGRATED_INCOMPLETE`

## 5. Data Model

### 5.1 `academic_years`

Proposed fields:

- `start_year INTEGER PRIMARY KEY`
- `label VARCHAR(...) NOT NULL`
- `closing_date DATE NOT NULL`
- `created_by UUID NOT NULL REFERENCES users(id)`
- `updated_by UUID NOT NULL REFERENCES users(id)`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Rules:

- `label` is derived consistently from `start_year`, for example `2025–2026`.
- Academic years with linked snapshots cannot be deleted.
- Closing-date changes are audited.
- Closing state is computed, not manually stored.

State calculation using the Asia/Manila calendar date:

- `OPEN`: current date is on or before the closing date.
- `CLOSING_SOON`: optional presentation state within a configurable threshold before closing.
- `CLOSED`: current date is after the closing date.

### 5.2 `student_academic_snapshots`

One row per student and academic-year start year.

Proposed fields:

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `student_number VARCHAR(20) NOT NULL`
- `academic_year_start INTEGER NOT NULL REFERENCES academic_years(start_year)`
- `student_name VARCHAR(...) NOT NULL`
- `college_id UUID`
- `college_name VARCHAR(...) NOT NULL`
- `program_id UUID`
- `program_code VARCHAR(...)`
- `program_name VARCHAR(...) NOT NULL`
- `year_level INTEGER`
- `source_import_group_id UUID`
- `source_type VARCHAR(...) NOT NULL`
- `source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE(student_number, academic_year_start)`

`source_type` values:

- `VERIFIED_HISTORICAL`: created during the authoritative schedule import for that year.
- `RECOVERED_HISTORICAL`: migration recovered the values from reliable existing historical records.
- `MIGRATED_INCOMPLETE`: migration used current-profile fallback because exact historical data was unavailable.

Historical labels are copied into the snapshot. Reports do not depend only on mutable college and program reference rows.

### 5.3 Snapshot immutability

- A new schedule import creates the snapshot in the same transaction as the student upsert and paired appointment publication.
- A later import for the same student and academic year must not silently overwrite the snapshot.
- Identical snapshot information is accepted idempotently.
- Conflicting information is rejected or placed into an administrator review path with an audit record.

## 6. Historical Migration

Migration order for each student and academic year:

1. Recover from reliable import-group or schedule-cycle records.
2. Recover from other historical schedule information with a clear relationship to that academic year.
3. Fall back to the current student profile only when historical values cannot be recovered.

Migration requirements:

- Idempotent: rerunning does not duplicate or alter verified rows.
- Audited: totals by source classification are recorded.
- Transparent: fallback rows are marked `MIGRATED_INCOMPLETE` in the UI and PDF.
- Conservative: uncertain values are not presented as verified.

## 7. Reporting Semantics

### 7.1 Reporting population

The selected academic year includes students with published Laboratory or Physical Examination appointments for that `schedule_cycle_start`, including inactive students and graduates.

Reports must not be limited to currently active student profiles.

### 7.2 Effective appointment selection

For each student, academic year, and schedule type:

- Consider published appointments only.
- Use the final current-effective appointment in that cycle.
- Ignore superseded or replaced appointments.
- A completed replacement overrides an earlier no-show, cancellation, or reschedule state.

### 7.3 Requirement completion

A requirement is complete only when its final effective status is `COMPLETED`.

Incomplete states include, but are not limited to:

- `UNSCHEDULED`
- `PENDING`
- `NO_SHOW`
- `CANCELLED`
- `AWAITING_RESCHEDULE`
- `RESCHEDULED` when no completed effective replacement exists

### 7.4 Overall classification

For an open academic year:

- Both requirements completed: `COMPLIED`
- Any requirement incomplete: `PENDING_COMPLIANCE`

For a closed academic year:

- Both requirements completed: `COMPLIED`
- Laboratory incomplete only: `DID_NOT_COMPLY_LABORATORY`
- Physical Examination incomplete only: `DID_NOT_COMPLY_PHYSICAL_EXAM`
- Both incomplete: `DID_NOT_COMPLY_BOTH`

The general overall-status filter may expose:

- `COMPLIED`
- `PENDING_COMPLIANCE`
- `DID_NOT_COMPLY`

`DID_NOT_COMPLY` includes all three closed-year noncompliance subtypes.

### 7.5 Summary consistency

All cards, breakdowns, table rows, and PDF totals use the same filtered reporting dataset and shared compliance calculator. The sum of detailed classifications must reconcile with the displayed summary.

## 8. Architecture

### 8.1 Shared filter parser

A shared report-filter module validates and normalizes:

- Academic-year start
- Search text
- Overall status
- Laboratory status
- Physical Examination status
- College ID
- Program ID
- Year level
- Sort
- Page and page size

Invalid optional filters fall back safely. Missing or invalid required academic-year scope returns a validation error.

### 8.2 Historical reporting repository

Create a dedicated repository for historical compliance reporting rather than directly adapting the current operational appointment summary.

Responsibilities:

- Join academic-year snapshots to effective published appointments for the selected cycle.
- Apply search, status, college, program, year, and data-quality filters.
- Return paginated detailed rows.
- Return unpaginated aggregate summary figures.
- Return grouped college, program, and year-level breakdowns.
- Return an export iterator or export result set using the same filters and sort.

### 8.3 Reporting service

The service coordinates:

- Academic-year validation and state
- Filter parsing
- Compliance calculation
- Summary and breakdown formatting
- PDF export dataset retrieval
- Audit metadata

### 8.4 UI components

Suggested focused components:

- `ReportAcademicYearHeader`
- `ReportSummaryCards`
- `ReportBreakdownTable`
- `ReportFilters`
- `ReportRecordsTable`
- `ReportPagination`
- `ReportExportButton`
- Academic-year settings form and history table

## 9. Routing

New routes:

- `/reports`
- `/api/reports/export/pdf`
- `/settings/academic-years`

Redirect behavior:

- `/appointments` redirects to `/reports`.
- Supported old query parameters are mapped to corresponding report filters where meaningful.
- Operational appointment actions remain in Laboratory, Physical Examination, student-detail, and clinic workflows.

Update authenticated route matching to include `/reports/:path*` while maintaining the redirect for `/appointments/:path*` as needed.

## 10. Authorization and Auditing

### 10.1 Authorization

Enforce administrator-only access at three levels:

1. Sidebar visibility
2. `/reports` page using `requireUser(["ADMIN"])`
3. `/api/reports/export/pdf` using `requireUser(["ADMIN"])`

The academic-year settings page and mutations also require `ADMIN`.

### 10.2 Audit events

Record at least:

- Academic year created
- Academic-year closing date updated
- Historical migration executed
- Snapshot conflict detected or resolved
- PDF report exported

PDF export metadata includes:

- Administrator user ID
- Academic year
- Normalized filters
- Sort
- Exported row count
- Generation timestamp

## 11. PDF Export

### 11.1 Strategy

Use server-generated PDF output. The browser view and PDF use the same report service, filters, sorting, and compliance logic.

### 11.2 Endpoint

`GET /api/reports/export/pdf`

Requirements:

- Administrator authorization
- Required academic year
- Current page filters and sort
- Complete matching dataset, not page-limited
- `application/pdf` response
- Download filename derived from academic year, main status filter, and generation date

### 11.3 Document layout

Use landscape orientation.

Header and summary:

- Central Philippine University MedClinic
- Compliance Report
- Academic year
- Closing date and year state
- Generation date and time
- Generated-by administrator
- Applied filters
- Summary metrics

Grouped breakdown table:

- College
- Course
- Year level
- Total
- Complied
- Pending or Did Not Comply
- Compliance rate

Detailed table:

- Student
- College
- Course
- Year
- Laboratory
- Physical Examination
- Overall
- Data Quality

Repeat detailed-table headers on each page. Add academic-year label and page number in the footer.

### 11.4 Large exports

Default maximum: 10,000 detailed records per PDF.

When the filtered result exceeds the limit:

- Do not produce a partial PDF.
- Return a clear validation response.
- Ask the administrator to narrow by college, course, year, or compliance status.

The implementation should stream PDF output where supported by the selected library.

## 12. Error Handling

- Missing academic year: validation message; export disabled.
- Unknown academic year: `404`.
- Unauthorized user: `403`.
- No matching records: empty-state message; export disabled.
- Closing date missing or invalid: academic year is configuration-incomplete and cannot be closed.
- Oversized export: reject without partial output.
- PDF failure: show an export error without clearing current filters.
- Incomplete historical source: include record with a visible data-quality warning.
- Snapshot conflict: do not overwrite; log and surface for administrator review.

## 13. Performance and Indexing

Add indexes appropriate to the final query plan, likely including:

- Snapshot academic year and student
- Snapshot academic year, college, program, year level
- Appointments by `schedule_cycle_start`, student number, schedule type, publication state
- Academic-year closing date when useful

Summary, breakdown, and detailed queries should reuse a common filtered CTE or equivalent SQL structure while avoiding repeated large scans when possible.

PDF export must bypass UI pagination but still use bounded, server-controlled limits.

## 14. Testing

### 14.1 Unit tests

- Academic-year label and state calculation
- Open-year compliance classification
- Closed-year Laboratory-only noncompliance
- Closed-year Physical Examination-only noncompliance
- Closed-year both-incomplete classification
- Completed replacement precedence
- Filter and sort parsing
- Data-quality labels
- PDF filename generation

### 14.2 Repository integration tests

- Historical snapshot remains unchanged after current profile changes.
- Inactive students appear in past reports.
- Different academic years return different snapshots for the same student.
- Published final effective appointments are selected correctly.
- Superseded and unpublished appointments are excluded.
- College, program, and year filters use snapshot values.
- Summary totals reconcile with detailed rows.
- Breakdowns reconcile with the overall filtered population.

### 14.3 Authorization tests

- Administrator can view Reports.
- Coordinator is denied.
- Clinic staff is denied.
- Non-administrators cannot call the PDF endpoint directly.
- Reports navigation is absent for non-administrators.
- Academic-year settings mutations reject non-administrators.

### 14.4 PDF tests

- Response type is `application/pdf`.
- Filename contains academic year and selected status context.
- Applied filters appear in the document.
- Summary totals match the reporting service.
- Detailed export includes all filtered rows, not one UI page.
- Headers repeat on multi-page output.
- Oversized exports fail without partial content.

### 14.5 Migration tests

- Reliable recovered rows use `RECOVERED_HISTORICAL`.
- Current-profile fallbacks use `MIGRATED_INCOMPLETE`.
- Verified rows are never downgraded or overwritten.
- Rerunning migration is idempotent.
- Migration totals and audit metadata are accurate.

### 14.6 Redirect and regression tests

- `/appointments` redirects to `/reports`.
- Compatible filters are preserved.
- Existing Laboratory and Physical Examination operational workflows continue to function.
- Existing student details and appointment histories remain accessible through their intended routes.

## 15. Acceptance Criteria

The design is successfully implemented when:

1. Only administrators can see and open Reports.
2. The old Appointments route redirects to Reports.
3. Administrators can select an academic year and review accurate summary figures.
4. Open years show incomplete students as Pending Compliance.
5. Closed years classify incomplete requirements as Did Not Comply.
6. Historical college, course, and year values remain stable after current profile changes.
7. Existing historical data is migrated and visibly classified by data quality.
8. Administrators can filter and sort by academic year, compliance, college, course, and year level.
9. The detailed table, summary cards, and breakdowns reconcile.
10. PDF export contains the current filtered report, grouped breakdowns, summary information, and all matching detailed records.
11. Oversized exports are rejected without partial output.
12. Authorization, migration, reporting, redirect, and PDF tests pass.

## 16. Implementation Notes

- Reuse existing UI primitives and CPU navy-and-gold design tokens.
- Reuse current effective-appointment concepts where valid, but scope them explicitly by academic year.
- Do not reuse the current operational appointment summary query unchanged because it focuses on active students and current appointments.
- Keep reporting, PDF rendering, academic-year configuration, and migration responsibilities in separate focused modules.
- Avoid unrelated refactors while implementing this feature.
