# Current Policy Index

Use this index when repository design records disagree. The [README](../README.md) and [first-installation guide](installation.md) describe current operation. Files under `docs/superpowers/specs` and `docs/superpowers/plans` record how the application evolved; a document labelled Historical or Superseded is retained as design history and is not current policy.

## Current operating policy

- Scope is college scheduling for Regular, OJT, Tour and First-Year/OVPSA students. K-12, `SPECIALIZED` and the staged generate/publish workflow are retired.
- Staff and students use separate sessions. Staff onboarding and student access require email verification. Student login requires a nonblank complete middle name and matches it case-insensitively.
- Scheduling uses Manila dates and weekdays. Laboratory precedes Physical Examination. First-Year/OVPSA keeps its owned reservations, external Laboratory accounting and minimum seven-calendar-day PE gap.
- Configured service capacity is the ceiling. Automatic and manual replacements remain in the original configured academic cycle; exhaustion enters Manual Resolution.
- The clinic calendar is unified. Closure changes use impact review and explicit recovery; reopening a date only restores availability.
- Laboratory clinical completion follows the versioned CBC/Urine/Stool/applicable X-ray checklist. Laboratory document uploads remain separate and support revision/edit/resubmit. Physical Examination student uploads are retired; CPU Clinic or an Administrator records the physician finding and issues a private immutable JPG certificate in the completion transaction.
- Bulk replacement reviews 1–100 eligible appointments in one service, clinic, and academic year against a chosen date, then saves the whole selection atomically. A partially verified Laboratory visit retains its checklist through an explicit replacement and is protected from automatic displacement.
- Current schedules exclude academic years after their stored Manila closing date. Staff and students retain authorized historical records and downloads. The clinic calendar reports internal capacity by service and published college groups without exposing clinical content.
- Effective appointment lineage, import-backed immutable snapshots, result revisions, private file authorization, audit events and encrypted retryable outbox delivery remain required.

## Current design authorities

| Area | Current authority |
| --- | --- |
| First-deployment corrections and cross-cutting policy | [Repository review and first-deployment readiness](superpowers/specs/2026-09-07-repository-review-first-deployment-design.md) and its [implementation plan](superpowers/plans/2026-09-07-repository-first-deployment-readiness.md) |
| Snapshot provenance and Reports | [Snapshot provenance follow-up](superpowers/specs/2026-09-05-snapshot-provenance-integrity-followup-design.md), [Reports cleanup design](superpowers/specs/2026-09-01-reports-data-quality-cleanup-design.md) and [plan](superpowers/plans/2026-09-02-reports-data-quality-cleanup.md) |
| Active scheduling categories and retired workflows | [Priority-group and legacy-scheduling retirement](superpowers/specs/2026-08-29-retire-priority-groups-and-legacy-scheduling-design.md) |
| Standard cycle boundary | [Standard schedule-import cycle horizon](superpowers/plans/2026-08-30-standard-schedule-import-cycle-horizon.md) |
| First-Year/OVPSA import and lifecycle | [First-Year schedule-import consolidation](superpowers/specs/2026-08-13-first-year-schedule-import-consolidation-design.md), as corrected by the September 7 readiness documents |
| Student verification and notifications | [Mandatory student email verification](superpowers/specs/2026-08-22-mandatory-student-email-verification-and-schedule-notifications-design.md) and its [plan](superpowers/plans/2026-08-22-mandatory-student-email-verification-and-schedule-notifications.md) |
| Staff account security | [Staff account security, onboarding, recovery and deletion](superpowers/specs/2026-08-25-staff-account-security-onboarding-and-deletion-design.md) and [staff login throttling](superpowers/plans/2026-08-31-staff-login-brute-force-protection.md) |
| Result uploads and revisions | [Student result multi-upload and editing](superpowers/specs/2026-08-06-student-result-multi-upload-editing-design.md) and its [plan](superpowers/plans/2026-08-06-student-result-multi-upload-editing.md), as corrected by the September 7 readiness documents |
| Final-defense clinical and scheduling workflows | [Final-defense revisions](superpowers/specs/2026-09-22-final-defense-revisions-design.md) and [implementation plan](superpowers/plans/2026-09-23-final-defense-revisions.md); this supersedes Physical Examination upload and generic completion guidance above |

## Historical and superseded guidance

The following records remain useful for rationale, but later documents above replace the named behavior:

| Historical record | Replaced guidance |
| --- | --- |
| July 18 automated scheduling design and plan | `SPECIALIZED`, optional student email and original scheduling/result architecture |
| July 22 clinic UI design and plan | generic Appointments/Results routes and earlier capacity/navigation details |
| July 26 calendar batch editor design and plan | separate-clinic changes and automatic restoration |
| July 27 unified calendar design and plan | original closure replacement rules and restoration behavior |
| August 2 Reports design and plan | predeployment historical recovery and Data Quality; those files already carry Superseded notices |
| August 12 First-Year/OVPSA design | standalone workflow and `SPECIALIZED`; replaced by consolidation and retirement policies |
| August 13 First-Year consolidation design | retained First-Year lifecycle, but later retirement and readiness documents replace `SPECIALIZED`, route aliases and corrected scheduling edges |
| August 14 closure policy design | original recovery mechanics; September 7 readiness policy supplies cycle bounds, future-date rules and capacity accounting |
| August 26 scheduling-integrity design and plan | retired lookup compatibility and the priority/closure behavior corrected by September 7 readiness work |
