# Configured import years, PE completion popup, and batch manual resolution

Date: 2026-09-27 (Asia/Manila)

Repository: Eida27/medclinic-scheduler-v2

Reviewed baseline: `bb36702eb921c81b5ab0b9b927c7316099b50091` on `main`.

Status: Proposed implementation design, committed at the user's request. The requested outcomes and shared-date batch mode are user-confirmed. Detailed defaults below are design recommendations for review, not claims of additional approval or completed implementation. This is a documentation-only change.

## 1. Design brief

Before first deployment, simplify three existing workflows:

1. At `/students/schedule-imports/new`, show only academic years configured through the Academic years tab.
2. On the Physical Examination list, provide a **Complete Physical Examination** button. It opens a popup where authorized staff record Class A, B, C, or D and submit once to complete that examination and release its existing JPG certificate.
3. In Manual Resolution, allow selection of multiple students or a group, choosing replacement dates using calendar availability and assigning the reviewed selection together.

The user selected **Same dates** for the new bulk manual assignment: selected students share the chosen Laboratory date and/or PE date. Insufficient capacity requires a smaller selection or different dates. Do not automatically distribute the new ordinary-case selection across days.

Assume an undeployed system and a completely clean database. No production-data conversion, imported medical findings, default physician signatures, or compatibility UI for superseded workflows is required. Preserve scheduling integrity, historical records, current authorization, and notifications.

### Design defaults

- Configured ended years remain visible but disabled and labelled **Closed** in the import dropdown; they cannot receive imports. Unconfigured years never appear.
- Retain mandatory certificate information in the PE popup. Selecting A–D alone cannot produce a complete certificate when physician, sex, or other required information is missing. Make preview optional and use one Submit action.
- PE completion is available to Administrators and staff assigned to CPU Clinic, as enforced by the current certificate service. Manual Resolution remains Administrator-only. This request does not expand Coordinator or other staff permissions.
- Ordinary bulk manual assignment accepts 1–100 cases from one academic year. It preserves unaffected services unless the Administrator explicitly chooses to move an eligible related service as well.
- Existing coordinated First-Year/OVPSA Laboratory recovery remains a separate whole-batch workflow, including its existing PE preservation/allocation policy. The new shared-date ordinary-case feature must not split or take ownership of an OVPSA batch.
- All selected ordinary cases commit together. A conflict blocks the entire submitted selection; no silent skips or partial saves.

## 2. Repository findings and approach

| Area | Current evidence | Required change |
| --- | --- | --- |
| Import dropdown | `src/components/schedules/ScheduleImportForm.tsx` builds seven years with `Array.from`, starting at the current Manila calendar year minus one. The page supplies no configuration data. | Load a small catalog derived from `academic_years`; remove generated options and calendar-year-only defaulting. |
| Academic-year administration | `src/server/services/academic-years.service.ts` and `src/server/repositories/academic-years.repository.ts` already read configured years. `/api/settings/academic-years` is Administrator-only. | Reuse the source data while keeping settings access restricted; provide an import-specific read catalog for Admin/Coordinator. |
| Import validation | `preflightScheduleImport` currently validates CSV/metadata/category without checking configuration. Standard publication locks the configured year; First-Year publication/review also checks it. | Validate year eligibility during preflight and retain locked final validation for both publication paths. |
| PE list | `src/components/appointments/ClinicPublishedSchedule.tsx` links to the detail page with “Complete examination.” | Replace that entry point with a role-aware button and one reusable popup. |
| PE form/service | `PhysicalExamCompletionForm.tsx` already records A–D and certificate fields but requires preview before showing the issue button. `completePhysicalExam` already completes PE and issues a certificate together. | Reuse that service and validation. Change presentation and submission flow; do not add a second completion writer. |
| Manual cases | `ManualResolutionQueue.tsx` has individual case forms and a dedicated OVPSA recovery card. `resolveClinicClosureManualCase` owns a transaction for one case. | Add selection, availability, preview, and an atomic bulk service using transaction-aware shared case logic. |
| Existing bulk replacements | `src/server/appointments/bulk-replacement.service.ts` already provides useful signed-preview, capacity, and retry patterns for ordinary appointment replacements. | Reuse patterns, not the endpoint: Manual Resolution must also close cases and update their existing reschedule events. |
| Calendar capacity | `calendar-occupancy.service.ts` and `schedule/scheduling-occupancy.repository.ts` distinguish internal usage, hidden holds, external Laboratory, and reservations. | Reuse capacity semantics for a selection-aware calendar; generic green/red tone alone cannot validate a group. |

### Approaches considered

| Approach | Benefit | Limitation |
| --- | --- | --- |
| UI wrappers plus separate per-student requests | Small initial change. | Partial batch completion and inconsistent case/capacity state remain possible. Rejected. |
| Extend current domain services with a popup and atomic batch operation **(recommended)** | Preserves certificate issuance, case lineage, audit, and capacity behavior while reducing user steps. | Requires extraction of transaction-aware case helpers and focused concurrency tests. |
| New scheduling/clinical subsystem | Could redesign every workflow at once. | Adds migration and maintenance scope without serving these three revisions. Rejected. |

Use the recommended approach. This spec supersedes the mandatory PE preview step in the September 22 final-defense design. Its certificate data, classification, JPG persistence, and correction/revocation requirements remain in force. Existing closure recovery rules, including emergency closures always requiring manual resolution, remain in force.

## 3. Configured academic years for imports

### 3.1 Data contract and selection

Introduce `listImportAcademicYears(now)` returning only `{ startYear, label, closingDate, state, selectable }` from configured records. `state` uses the existing `OPEN`, `CLOSING_SOON`, and `CLOSED` calculation in `src/lib/academic-year.ts`. `selectable` is false when Manila today is later than `closingDate`. A selectable year is not a guarantee that the requested import fits its scheduling window or capacity.

The authenticated server page loads the initial catalog and passes it to `ScheduleImportForm`. Add `GET /api/schedule-imports/academic-years`, authorized for `ADMIN` and `COORDINATOR`, for refreshes. Return private/no-store data without actor IDs, counts of linked records, or settings mutation authority. Keep all existing academic-year settings endpoints Administrator-only.

Sort options by start year descending. Label closed entries `2025–2026 — Closed` and disable them. Choose the most recent selectable year whose August 1 start is on or before Manila today; if none exists, choose the earliest configured upcoming selectable year. If none is selectable, use an empty placeholder. Never inject the browser's calendar year as an option or infer a record from appointments.

Both Standard and First Year import modes use this same catalog. Keep the existing nine-column CSV, year/category policy, preferred-month rules, preparation boundary, first-year authoritative Laboratory date, and atomic publication.

### 3.2 Empty, stale, and unavailable states

- No records: show **No academic years are configured.** Disable Review import and publication. Administrators receive a link to `/settings/academic-years`; Coordinators see **Ask an Administrator to configure an academic year.**
- All configured years closed: show the closed options and **No configured academic year is open for imports.** Disable review/publication.
- Read failure: show **Unable to load academic years** with Retry. Never fall back to generated years.
- Refresh on focus, return to visible tab, and Manila date rollover. Keep a valid explicit choice. If it becomes missing/closed, clear it and invalidate any import confirmation or First Year review; require another choice. Do not silently switch a reviewed import to a different year.
- Changing the selected year clears the existing review/confirmation, matching category/file changes.

### 3.3 Server enforcement

Check configured-year existence and closing date during preflight, First Year review, and both final publication paths. Use the existing year-boundary lock in the publication transaction so concurrent deletion or closing-date changes cannot invalidate a committed schedule. A review is not a reservation.

Return field errors against `academicYearStart`, with `ACADEMIC_YEAR_NOT_CONFIGURED` for missing years and `ACADEMIC_YEAR_ENDED` for closed years. A direct or stale HTTP request receives the same checks as the dropdown. If a closing date is shortened after review, recompute the scheduling result and either produce a valid in-bound publication under current rules or reject it without writes; do not publish the obsolete reviewed First Year allocation.

Do not broaden all historical-year selectors or change the Academic years management UI. This revision targets new imports.

## 4. Complete Physical Examination popup

### 4.1 Entry points and context

On each eligible `/physical-exam` row, display a button labelled exactly **Complete Physical Examination**. Clicking it opens a modal card without navigating away. The detail page uses the same form/controller so both entry points have identical validation and submit behavior. Preserve detail links for history, external Laboratory verification, and certificate revisions.

Pass a server-derived `canCompletePhysicalExam` capability to the list; do not derive authority from whether a row happens to have completed Laboratory. Show completion controls only to current authorized Admin/CPU Clinic staff. Completed and historical records display their status and authorized certificate/history actions.

Add `GET /api/appointments/[appointmentId]/physical-exam-completion-context` to load the selected record on demand. Authorize it like completion, enforce clinic scope, validate the ID, and return private/no-store context: identity/academic snapshot, DOB/derived age inputs, scheduled date, server Manila today, current status, automatic-no-show eligibility, effective Laboratory readiness, active physician catalog, and actionable blockers. Do not return certificate JPG bytes or signature assets. Reuse a focused server context helper in the detail page where appropriate.

Load context only for the active popup. Opening another record or closing the popup cancels/ignores obsolete requests and clears the previous student's fields. Loading or failed context disables Submit. A missing snapshot, DOB, active physician, or completed Laboratory has a clear explanation and an authorized route to resolve it.

### 4.2 Form content

| Field/action | Behavior |
| --- | --- |
| Student identification | Read-only name, student number, academic year, and scheduled PE date, prominently displayed. Academic identity comes from the existing snapshot. |
| Classification | Four mutually exclusive radio choices: Class A, B, C, D. No default class. Keep the existing labels: unrestricted school activities; correctible limitations; restricted activities/follow-up; unfit for school activities. Staff record the physician's finding; the application does not infer it from Laboratory tests. |
| Findings / remarks | Required for B/C/D; optional for A. Retain the current 1,000-character and control-character rules. Record the clinical detail in this popup. |
| Actual examination date | Default to the scheduled date when it is not in the future; otherwise require an explicit valid date. Never substitute today silently for an unknown actual examination date. Enforce the existing open-cycle, nonfuture, and Laboratory-date rules. |
| Sex recorded for this examination | Required under the existing certificate schema. Do not guess from name or add a tenth CSV column. |
| Physician | Use active configured profiles and their version. Auto-select only when exactly one active profile exists, display it, and allow review. Otherwise require selection. |
| Late-encoding reason | Show and require when actual examination date is before server Manila today or when correcting an automatic no-show, matching current service rules. |
| Attestation | Retain the explicit checkbox confirming the entry matches the physician's recorded finding. Do not precheck it. |
| Preview certificate | Optional secondary action. Same validation and private watermarked renderer; never completes the appointment. Editing a field invalidates an existing preview. |
| Submit | Primary action. Validates and sends one completion request directly, without requiring Preview first or a second confirmation popup. |
| Cancel | Closes without writes when not submitting. |

Use a scrollable modal, visible field labels, accessible error summary, focus trapping/restoration, and keyboard operation. Follow the existing dialog patterns; prevent repeated submit and dismissal during an in-flight write. Keep entered values after a recoverable failure. Announce loading and outcome with accessible status text.

The default path is **Complete Physical Examination → record class and required details → Submit**. A Class B, C, or D result still means the examination is completed; fitness classification is not appointment attendance/status.

### 4.3 One authoritative completion operation

Continue calling `POST /api/appointments/[appointmentId]/complete-physical-exam` and `completePhysicalExam`. The popup submits the existing certificate schema (`requestId`, physician ID/version, actual date, sex, class, remarks, conditional late reason, attestation). It never sends a separate generic status update.

Preserve current live authorization, effective same-cycle/pair resolution, completed required Laboratory checklist and external verification, pending/eligible automatic-no-show rules, and open-cycle checks. A manual lock is a scheduling protection under current behavior; this spec does not invent a new clinical-completion bypass or silently remove a lock. Existing service validation remains authoritative when context becomes stale.

Rendering and completion keep the current prepared-context comparison and transaction model: render valid JPG bytes, then revalidate under effective appointment scope locks and commit certificate revision/bytes, appointment completion, exam result, audit/status events, notification/outbox work, and request outcome together. Failure before commit leaves the examination uncompleted. SMTP delivery remains asynchronous.

Maintain request IDs for exact retries. While the outcome is uncertain after a network failure, offer retry of the same payload/request ID or reload its state before a changed submission. A new deliberate attempt after a definitive validation failure may use a new ID. Recheck a matching saved request outcome after waiting for the effective-scope lock, so a concurrent identical submission that committed during the wait returns its original result. Never create a duplicate certificate because of double-clicks, reopening, or retry after a successful response was lost.

On success, refresh the list and show **Physical Examination completed — Class X** with Download JPG. Preserve filters/page when possible; if a Pending filter removes the row, keep the success message and download available. Update the detail view, student results, and certificate availability from committed server data. Do not optimistically mark completion before success. Stale-state errors should say **The record changed. Refresh and review the details**, without requiring the now-optional preview.

Certificate correction, revocation, and historical download remain separate existing actions. PE result uploads remain removed.

## 5. Bulk Manual Resolution

### 5.1 Selection and group meaning

Keep `/settings/clinic-unavailable-dates/manual-resolution` Administrator-only. Add checkboxes, **Select eligible on this page**, a selected count, **Clear selection**, and **Assign schedules (N)**. Preserve individual assignment and Keep current replacement for cases that need individual decisions; bulk Keep current replacement is outside this revision.

Allow selection across pages within the same filter context, with explicit case IDs and optimistic tokens. Sorting may retain it; changing search, academic year, status, service, closure group, or import group clears it and any preview. Keep selection in memory, not persistent storage containing student/clinical information. Refresh eligibility on focus and date rollover and invalidate stale previews.

Add an **Import batch** filter using `schedule_import_groups` identity, resolved through source appointment `batch_id → schedule_batches.import_group_id` or verified OVPSA source provenance. A replacement retains its source lineage. Do not group by filenames alone or invent a new batch table. Keep **Closure group** as a separate grouping choice because a closure can span imports.

**Select eligible in this group** performs a bounded server query for all matching IDs/tokens rather than selecting only the loaded page. Return total, eligible, and blocked counts with reasons before selection. Select at most 100 ordinary cases; when a group exceeds the limit, ask the Administrator to narrow the group or select an explicit subset. Never silently select the first 100 and label it the whole batch.

Ordinary selections may span imports/closures but must belong to one configured, unended academic year. Reject duplicate case IDs and overlapping cases for the same student/cycle or source appointment. Disable resolved/historical cases and structurally invalid pairs with explanations. Determine eligibility against the services that would move: a completed/protected preserved Laboratory must not block an otherwise valid PE-only replacement. Revalidate every submitted ID on the server.

### 5.2 Shared dates and preserved services

The assignment popup displays the selected students, their affected services, current pair dates, and any existing protection. For each service:

- **Replace affected services only** is the default. An affected unfinished service requires the shared replacement date. An unaffected service is explicitly preserved in the generated per-case plan.
- An optional **Also replace eligible related services** choice applies that service's shared date to the selected students with a movable related appointment. Preview must list every affected/preserved/moved service. If any requested related service is protected, block the selection until the user changes the choice or selection; never quietly preserve a row the user asked to move.
- A completed service always remains completed and preserved. If it prevents a valid pair under the chosen dates, show the conflict and keep the case open.
- Require one common resolution reason, trimmed to 3–500 characters, and a clear confirmation that the displayed unaffected services will be preserved. Server-built per-case requests use explicit preserve flags rather than relying on omitted fields.

Ordinary Laboratory must remain strictly before PE, with at least one calendar day between date-only appointments. Applicable OVPSA PE-only cases retain the existing seven-calendar-day rule and reservation rules. A shared Lab date can be valid for one preserved PE and invalid for another; the full selection must pass. The reviewed scope can move both services in the same transaction.

Replacement dates must be after today in Asia/Manila, be clinic weekdays, fall within the original configured cycle through its closing date, and pass closures/service reservations. These are manual replacement rules: do not reapply the seven-day preparation notice used for new imports, and do not relax the separate OVPSA Lab-to-PE gap.

### 5.3 Availability calendar and preview

Provide a monthly date picker for each service being moved, showing used, maximum, available, and seats required by the selection. Fetch a bounded month at a time, including days with zero appointments; an absent day in the existing occupancy response is not proof that capacity is missing or unlimited.

| Calendar state | Meaning/action |
| --- | --- |
| Green / Available | The selected service has capacity for the proposed group and its date-level rules permit selection. Pair checks still appear in preview. |
| Red / Full | No capacity remains for that service; disabled. |
| Amber / Not enough space | Some seats remain, but fewer than this selection requires; disabled with counts. |
| Closed, reserved, past/today, weekend, outside cycle | Disabled with the specific reason, even if occupancy is zero. |
| Capacity not configured | Neutral/unavailable; direct the Administrator to capacity settings. |

Use labels and counts as well as color. Evaluate the service being moved: a full Laboratory does not by itself disable an otherwise valid PE date. External Mission Hospital Laboratory is not charged against internal KABALAKA capacity.

For every destination `(clinic, service, date)`, calculate `projected = current consuming appointments - selected consuming sources leaving that destination + planned replacements at that destination`. Count each source and replacement once. Do not subtract an `AWAITING_RESCHEDULE` source that already consumes no capacity. Count hidden holds and existing active consuming records with `internalOccupancyPredicate`, independently of current-view or academic-year visibility filters.

Selecting dates does not write records or reserve capacity. **Preview assignments** produces one row per case with old/new Lab and PE dates, preserve/move decisions, retained checklist progress, and conflicts. Show aggregate capacity by destination, selected student count, and replacement appointment count separately. A row with a problem prevents the confirm button; the Administrator can remove rows or change dates, then preview again. Do not silently drop invalid submitted rows.

On successful preview, **Confirm assignments** commits the exact reviewed plan. Any selection/date/mode/reason edit invalidates it. After success, clear selection, refresh the queue/calendar, and display the resolved student count and assigned dates.

### 5.4 Proposed ordinary-case API and service boundaries

All routes below require a live Administrator session and private/no-store responses.

| Proposed route | Contract |
| --- | --- |
| `GET /api/clinic-unavailable-dates/manual-cases/selection` | Validated current filters/group; return bounded explicit ordinary case IDs/tokens, display data, and total/eligible/blocked counts. No mutations. |
| `POST /api/clinic-unavailable-dates/manual-cases/availability` | Selected IDs/tokens, replacement scope, and a bounded month; return service/date capacity and date-level blockers. No mutations or reservations. |
| `POST /api/clinic-unavailable-dates/manual-cases/bulk/preview` | 1–100 unique `{ caseId, expectedOptimisticToken }`, shared optional Lab/PE dates, explicit service replacement scope, preservation acknowledgement, and reason. Return canonical rows, conflicts, capacity, expiry, and a preview token only when all pass. |
| `POST /api/clinic-unavailable-dates/manual-cases/bulk/resolve` | Same canonical input plus `requestId` and `previewToken`; return resolved case IDs, source/replacement mappings, student and appointment counts. |

Use strict Zod schemas and real calendar-date validation. Scope/mode determines which shared dates are required or prohibited; reject contradictory preserve/replace intent. Bound list/body/month requests and reject duplicate or cross-cycle inputs before writes. Resolve appointment IDs, clinic, academic year, and import ownership from stored case/lineage data, not trusted client claims.

Extract focused planning/apply helpers accepting an existing `PoolClient` from the single-case resolver. The bulk writer owns one outer transaction and applies validated plans through those helpers; it must not loop over HTTP calls or over the existing transaction-owning public resolver. Preserve the single-case resolver's action/error semantics through the shared logic.

Sign a preview proof with a domain-separated `medclinic:manual-resolution-preview:v1` key derived from the configured signing secret. Bind it to actor, canonical case IDs/tokens, input, source/effective-pair versions, relevant checklist/protection state, academic boundary, closures/reservations, capacity, and a ten-minute expiry. Keep clinical details out of the token. Existing ordinary bulk-replacement tokens must not authorize manual-case writes. The proof is not a capacity reservation.

### 5.5 Commit, concurrency, and retries

The transaction must:

1. Revalidate the current actor's active/onboarded Administrator authority. Acquire the existing global scheduling queue advisory lock.
2. Check successful request replay by actor/request ID and canonical action/payload hash. Return the saved outcome for an exact authorized retry, even if its preview has since expired; reject reuse with different input.
3. Verify the signed preview. Discover all affected effective scopes, acquire them in the shared deterministic order, then lock/re-read cases, appointment pairs, checklist/protection records, academic boundaries, and relevant capacity/rules consistently with other writers. A case token alone does not capture subsequent clinical or capacity changes.
4. Rebuild and compare the complete plan. Recheck every destination's aggregate projected capacity. If any case, source, protected state, policy, or capacity differs materially, return a conflict and roll back without closing cases or publishing replacements.
5. Mark only moving predecessors rescheduled/unpublished and insert linked published successors with the original academic cycle, pair, scheduling/import provenance, and permitted checklist lineage. Preserve completed/unmoved services. Preserve already verified checklist items and their original audit identities/timestamps where manual movement is allowed. Manual-resolution locks and protected results retain their current blocking behavior; do not copy the ordinary bulk-replacement lock-override policy into this path.
6. Resolve every selected case, rotate its token, and update its existing `appointment_reschedule_events` mappings. Write per-case audits plus one batch audit, with the reason and shared request ID. Queue the existing authoritative schedule-change portal notifications and eligible email outbox items once per resolved student/cycle, using stable event keys.
7. Store the successful outcome and commit all data together. An injected failure anywhere rolls back appointments, case status, history, audits, notifications/outbox records, and the replay record.

Make the single-case and affected OVPSA recovery paths follow the same effective-scope lock order before touching appointment/checklist rows. Verify races against clinical completion, checklist updates, no-show, another resolver, imports, closures, and capacity edits. A queue lock that only scheduling writers acquire is insufficient protection against clinical writers.

Reuse `clinical_mutation_requests` with the distinct action `BULK_MANUAL_RESOLUTION` and an immutable outcome containing IDs/counts, not medical text. A unique actor/request key plus the scheduling lock prevents parallel duplicates. Exact retries after lost responses return the same replacements and do not send duplicate notifications.

### 5.6 First-Year/OVPSA whole-batch recovery

Do not include coordinated Laboratory cases in ordinary bulk selection or call the ordinary bulk resolver on them. Present an **OVPSA batch — coordinated recovery** group action and retain the existing external Laboratory revision/reservation/membership and seven-day separation policy.

The current UI groups only the cases on the loaded queue page while confirmation validates all linked cases. Introduce an authorized full-batch context read under the existing `/manual-cases/ovpsa-batches/[batchId]` route family. Resolve all open linked IDs/tokens and authoritative batch revision on the server, show the whole-batch count, and confirm exactly that membership. Use paginated member display if needed, but never submit only the visible page as the batch. Bound membership to the existing import limit and fail explicitly on inconsistent membership.

Display the existing planner's preserved and moved PE allocations with dates and capacities before confirmation. This specialized existing flow may distribute PE recovery across available dates; it is expressly separate from the user's selected shared-date mode for the new ordinary bulk feature. Do not introduce automatic spreading into ordinary selections. An incompatible OVPSA batch remains open with a reason rather than being split to fit the 100-case ordinary limit.

## 6. File impact and data changes

Paths marked **new** are proposed, not existing files at the reviewed baseline.

| Area | Planned files |
| --- | --- |
| Import years | `src/app/(dashboard)/students/schedule-imports/new/page.tsx`; `src/components/schedules/ScheduleImportForm.tsx`; **new** `src/app/api/schedule-imports/academic-years/route.ts`; academic-year service/repository and `src/server/services/schedule-imports.service.ts`; final standard/First-Year boundary checks. |
| PE popup | `src/app/(dashboard)/physical-exam/page.tsx`; `src/components/appointments/ClinicPublishedSchedule.tsx`; `AppointmentDetail.tsx`; `PhysicalExamCompletionForm.tsx`; **new** `src/components/appointments/PhysicalExamCompletionDialog.tsx`; **new** completion-context route/service; existing certificate route/service and stale-error copy. |
| Manual resolution UI | `src/components/settings/ManualResolutionQueue.tsx`; **new** `src/components/settings/ManualResolutionBatchDialog.tsx`; **new** `src/components/settings/ManualResolutionDatePicker.tsx`; `src/types/clinic-calendar.ts`. |
| Manual resolution server | New routes from section 5.4; **new** `src/server/services/manual-resolution-batch.service.ts`; focused shared plan/apply helpers extracted from `src/server/services/clinic-calendar.service.ts`; manual-case query/group mapping and full OVPSA batch context. |
| Shared integrity | Existing effective-pair/scope-lock, scheduling-occupancy, blocked-date, notification, checklist, and academic-boundary helpers; narrow changes needed for the operations above. |
| Schema | **new** `database/migrations/029_manual_resolution_batch_requests.sql`, using the next unused migration number at implementation time. |
| Regression coverage | Corresponding page/component/API/unit tests and PostgreSQL integration tests for catalog enforcement, certificate completion, selection, capacity, locks, all-or-nothing rollback, replay, and OVPSA membership. |

No new year, finding, or appointment-status table is needed. Existing certificate revisions store classification/remarks; the current clinical transaction completes PE. Extend the `clinical_mutation_requests.action` constraint to allow `BULK_MANUAL_RESOLUTION`, retaining all existing actions and immutability. Add an index for group selection only if query plans demonstrate a need with representative fixture sizes.

Use an additive migration in the repository's existing migration chain, even for fresh deployment, to keep installations reproducible and local development databases coherent. No production backfill or destructive reset is part of this work. Reference seed stays reference-only: an empty year catalog must remain a valid install state until an Administrator configures years. Do not seed fictional clinical findings or active physician signatures.

Update README/workflow documentation after implementation, including screenshots from the new running UI. Historical design documents remain historical; this document explicitly overrides only the workflows identified above.

## 7. Implementation sequence

1. Deliver the configured-year catalog, page/form states, and authoritative validation for both import modes.
2. Extract PE completion context and reuse the existing form in a list popup; make preview optional and preserve one transaction for completion/certificate issuance.
3. Extract transaction-aware manual-case planning/apply helpers and establish shared lock ordering without changing individual behavior.
4. Add ordinary-case group selection, selection-aware calendar, signed preview, request action migration, and atomic bulk resolve.
5. Connect the batch popup and refresh behavior; fix OVPSA complete-membership loading while retaining its specialized recovery rules.
6. Execute focused regression/concurrency checks and the clean-install acceptance walkthrough; update user documentation.

This sequence guides a later implementation plan. This documentation commit does not authorize or claim execution of application changes.

## 8. Acceptance and validation

### 8.1 Import

- With only 2026–2027 configured, no generated 2027–2028 through 2031–2032 options appear. A configured year outside the former seven-year range does appear.
- Admin and Coordinator see the same catalog; only Admin receives the settings link. Unauthorized roles cannot call the catalog or import endpoints.
- Empty database and closed-only catalog show the specified messages and disable review/publication. Read failure never produces fallback years.
- January–July defaulting selects the configured cycle that actually started, not simply the calendar year. Closing date remains usable through that Manila day; the next day is closed.
- Tampered, deleted, or newly closed year requests fail during preflight and final submission without publishing or orphaning students/snapshots/imports. Both Standard and First Year are covered.
- A year/closing-date change invalidates stale review and observes the live final scheduling boundary; year/category, preparation, capacity, and atomic-import regressions pass.

### 8.2 PE

- The list button opens the correct student's popup without leaving the list. Switching/closing students never leaks form state or late responses into another student's popup.
- Each of A/B/C/D can complete a valid examination through one Submit. No class is preselected. B/C/D require remarks and show Completed after success.
- Required sex, physician, attestation, actual-date rules, late reason, and snapshot prerequisites remain enforced. Optional preview has no persistence side effects and is not a prerequisite to Submit.
- An incomplete/wrong-cycle Laboratory, missing external verification, ineligible status, ended year, stale physician, or wrong role/scope blocks issuance. UI capability and direct endpoint checks agree.
- Rendering failure and injected transaction failure leave no partially completed examination, certificate, or notification. Concurrent completion/checklist/rescheduling and repeated/lost-response requests cannot issue duplicate certificates or complete the wrong pair.
- The successful JPG matches the submitted classification/remarks and stored snapshot. Student-owned download works, existing revisions/history remain accessible, and email content contains no classification or medical findings.
- Keyboard/mobile use, loading/errors, focus restoration, filters after success, and download after the row leaves a Pending filter are verified in the browser.

### 8.3 Manual Resolution

- Select individuals, a page, or a named import/closure group across pagination; counts match server membership. Mixed/oversized groups, duplicate/overlapping cases, stale selections, and changed filters behave explicitly.
- PE-only assignment with a preserved completed Laboratory succeeds when valid. Both-service assignment checks the final pair together. Moving protected/completed services fails without changing cases.
- For 12 remaining seats, 12 selected replacements fit; 13 fail. Capacity accounting correctly handles sources already excluded from occupancy, sources moving away, hidden holds, full other services, and external Laboratory.
- Closed/reserved/weekend/today/past/out-of-cycle/unconfigured dates are unavailable regardless of calendar color. Insufficient capacity does not trigger automatic date spreading or partial assignment.
- Preview makes no writes. Token tampering, wrong actor, ordinary bulk token reuse, expired proof, changed input, changed case/pair/checklist/rules/capacity, or revoked authority is rejected.
- Fault injection on the final case rolls back all earlier selected cases, replacements, events, audits, outbox/notifications, and request records.
- Exact successful replay before or after token expiry returns original IDs; altered replay input conflicts. Two competing groups/imports cannot overbook. Clinical/scheduling races follow a verified consistent lock order.
- Case history and authoritative schedule notifications reference the final pair correctly; retained partial checklist progress and completed service history are preserved.
- More-than-one-page OVPSA recovery reviews/submits the full linked batch; partial/tampered membership fails. Ordinary selection cannot split a coordinated batch or bypass its reservations, revision history, or seven-day gap.
- Emergency closure and 30-day recovery policy remain unchanged. Manual assignment still requires deliberate preview and confirmation.

### 8.4 Fresh-install acceptance and completion gate

Rehearse on a disposable empty database: migrations through the new migration, reference seed, first-Administrator bootstrap/onboarding, empty import-year state, year/capacity/physician configuration, staff onboarding, Standard and First Year imports, Laboratory completion, each PE class, JPG download, emergency/manual cases, ordinary shared-date bulk assignment, OVPSA recovery, and ended-year read-only history.

For implementation, use the repository's `npm run test:migrations:empty`, focused `npm test -- <paths>`, targeted PostgreSQL integration suite via `npm run test:integration`, `npm run lint`, and `npm run build` with the documented test/development configuration. Read the installed Next.js guides required by `AGENTS.md` before product-code changes. Use synthetic fixture identities and authorized test assets.

The implementation is accepted when all three workflows meet these criteria without weakening clinical/capacity rules or requiring users to edit SQL/API data manually. For this spec-only commit, verification consists of source/path traceability, consistency and placeholder review, Markdown/diff checks, and verification of the resulting GitHub commit; application tests are not claimed to have run.
