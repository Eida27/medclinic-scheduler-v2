# Final-defense revisions: laboratory checklist, bulk replacements, certificates, calendar capacity, and academic-year visibility

Date: 2026-09-22

Repository: Eida27/medclinic-scheduler-v2

Reviewed baseline: a8e89097c1bbf07f91bc6bdb42f1e955fcc23680 (main)

Status: Proposed implementation design. The three workflow choices in section 1 are user-confirmed. The remaining concrete defaults are recommendations for review. This document does not claim the features are implemented.

## 1. Design brief and confirmed decisions

The panel requested five connected revisions before the system's first deployment:

1. Replace the appointment status action buttons with laboratory test checkboxes: CBC, Urine, Stool, and conditionally X-ray.
2. Let authorized staff select multiple students when creating replacement appointments.
3. Remove student Physical Examination result uploads and provide a high-quality downloadable JPG medical certificate after examination completion.
4. Color calendar dates by capacity and show student counts grouped by college and appointment service.
5. Automatically hide appointments after their configured academic year ends.

The user explicitly selected these workflows:

| Decision | Confirmed behavior |
| --- | --- |
| Meaning of laboratory checkboxes | A checked test means clinic staff confirmed completion or verified its external result. Uploading a document does not check a test. |
| Certificate release | Staff enter the physician's finding and certificate details in the examination completion form. One successful save completes the examination and releases its JPG. No automatic Class A finding. |
| Bulk replacement dates | Staff select multiple students, choose one replacement date, and preview capacity and scheduling conflicts before saving. No automatic distribution across other dates. |

The deployment assumption is a completely fresh, clean database with no production records to preserve or backfill. The implementation must remove superseded runtime paths, obsolete tests, and misleading documentation while preserving still-used scheduling, authorization, notification, and history behavior.

Success means the five workflows work together: partial laboratory work survives valid replacement; Physical Examination cannot bypass its laboratory prerequisite; a completed examination has an issued certificate; calendar counts agree with scheduling capacity; and ended-year records remain recoverable without cluttering current work.

### Concrete defaults supplied by this design

These defaults resolve details that were not separately selected by the user:

- CBC, Urine, and Stool apply to every supported student category. X-ray applies when the appointment's immutable academic snapshot has year level 1, or year level 4 and its scheduling category is OJT.
- Bulk replacement applies to one service, one clinic, and one academic year at a time. Save is atomic for the entire reviewed selection.
- Existing ADMIN and assigned CLINIC_STAFF authority is retained. A COORDINATOR account does not gain clinical editing, certificate issuance, or bulk replacement authority.
- A red calendar date means at least one internal clinic service is at capacity. The details identify which service is full; the other service may still have room.
- Colorless means no booked students, rather than a zero configured capacity. Closed, unconfigured, and reserved dates receive explicit separate labels.
- Ended-year appointments disappear from current views, not from storage. Historical views and certificate downloads remain available to authorized users.
- Physician identity and an authorized signature asset are configured by an Administrator. These are configuration records, not new physician login accounts.
- Store the final JPEG bytes with their immutable certificate record in PostgreSQL, so completion and release can commit together without a separate file-publication step.

These defaults are part of the proposed design, not additional statements of user approval.

## 2. Existing implementation and architectural approach

The application uses Next.js 16.3.5, React 19.2.4, PostgreSQL through pg, Zod, Vitest, private local result-file storage, and a retryable encrypted email outbox. These versions describe the reviewed repository, not an instruction to upgrade dependencies.

Relevant current boundaries:

| Existing area | Current implementation | Design consequence |
| --- | --- | --- |
| Appointment lists and actions | src/components/appointments/ClinicPublishedSchedule.tsx, AppointmentQuickStatusButton.tsx, AppointmentActions.tsx | Replace completion entry points, including detail-page and API bypasses. |
| Mutation service | src/server/services/appointments.service.ts | Extract focused clinical and bulk services; retain shared locking, lineage, audit, and notifications. |
| Pair resolution | src/server/repositories/effective-appointment-pair.repository.ts and src/server/appointments/appointment-pair-integrity.ts | Resolve the effective pair within the original cycle and pair identity, never another year's completed Laboratory. |
| Manual replacement | src/server/appointments/manual-appointment-destination.ts and getManualRescheduleDestinationState in appointments.repository.ts | Reuse date, capacity, cycle, and pair-order validation for a whole selection. |
| First-Year/OVPSA | src/server/ovpsa/external-laboratory-verification.service.ts and batch lifecycle services | Preserve external verification provenance and batch ownership. |
| Student uploads | src/server/services/student-result-submissions.service.ts and its repository | Retain Laboratory uploads and revisions; remove all Physical Examination upload branches. |
| Calendar | src/components/settings/ClinicUnavailableCalendar.tsx and src/server/services/clinic-calendar.service.ts | Add occupancy without replacing closure drafting, impact preview, or recovery. |
| Academic years | src/lib/academic-year.ts and src/server/repositories/academic-years.repository.ts | Use closing_date and Asia/Manila consistently. |
| Current schedule/results | current-effective-appointments.repository.ts, appointment-summary.repository.ts, student-portal.repository.ts, and schedule/schedule-state-sql.ts | Add explicit cycle scope before ranking and pairing; keep historical reads distinct. |
| Automatic no-show | src/server/repositories/appointment-no-show.repository.ts | Do not label a partially completed laboratory visit as no-show. |
| Fresh installation | database/migrations/001 through 027 and scripts/db-migration-empty-database-test.ts | Extend the tested migration chain and remove superseded behavior in the final schema. |

### Selected approach

Evolve the existing workflows with focused services for laboratory checklist changes, certificate issuance, bulk replacements, calendar occupancy, and academic-year visibility. Existing scheduling writes and notifications remain authoritative.

A UI-only change would leave old API completion and upload paths active, permit contradictory records, and miscount calendar capacity. A second parallel clinical/results subsystem would duplicate authorization and reporting. Both alternatives are rejected.

Retain separate concepts:

- Laboratory clinical progress: staff verification of individual tests.
- Laboratory document submission: uploaded files and their revision/finalization lifecycle.
- Physical Examination completion: recorded physician finding plus an issued certificate.
- Scheduling state: appointment date, replacement lineage, closure recovery, and attendance metadata.

Reports must label these concepts accurately. An uploaded file does not imply clinical fitness, and a Class B, C, or D certificate still documents a completed examination.

## 3. Laboratory checklist

### 3.1 Applicability and interface

| Appointment's recorded academic context | CBC | Urine | Stool | X-ray |
| --- | --- | --- | --- | --- |
| First year, including First-Year/OVPSA | Required | Required | Required | Required |
| Fourth-year OJT | Required | Required | Required | Required |
| Every other supported year/category | Required | Required | Required | Not applicable |

Determine year level from student_academic_snapshots for appointment.schedule_cycle_start. Determine category from the appointment's authoritative scheduling_category and OVPSA provenance. Do not use the student's mutable current year/category or infer applicability from age, course, filename, or the current date. Missing provenance is an actionable integrity error, not a reason to silently waive X-ray.

Create the required test set when the Laboratory appointment is first published. A replacement in the same lineage inherits that set. A new academic year receives a fresh checklist.

Replace the Laboratory quick-status button with separately labelled CBC, Urine, Stool, and applicable X-ray checkboxes. Non-applicable X-ray is displayed as “Not required” in the detail view and is not a clickable empty checkbox. Show “0/3 verified”, “2/3 verified”, or “4/4 verified” as appropriate, with a small noninteractive scheduling-status label where needed.

Authorized checkbox changes save immediately, with a pending state and clear error recovery. Serialize changes per checklist, restore the last confirmed server state after failure, and announce successful progress changes accessibly. Checkboxes are not bulk clinical confirmation controls.

On Physical Examination rows, show Laboratory progress read-only and a “Complete examination” action opening the certificate form. The laboratory test labels do not replace the examination finding form.

### 3.2 Data model

Add these focused tables:

| Table | Core fields and invariants |
| --- | --- |
| laboratory_checklists | id, root_appointment_id UNIQUE, student_number, academic_year_start, academic_snapshot_id, year_level_snapshot, scheduling_category_snapshot, requirements_version, version, created_at. Identity and requirement snapshots are immutable. |
| laboratory_checklist_items | checklist_id, test_code constrained to CBC/URINE/STOOL/XRAY, verified_at nullable, verified_by nullable, verification_source INTERNAL/EXTERNAL nullable. Composite primary key (checklist_id, test_code). Only required items exist. Verification fields are either all absent or all present. |
| laboratory_checklist_appointments | appointment_id PRIMARY KEY, checklist_id. Every published Laboratory appointment maps to exactly one checklist; predecessor and replacement map to the same checklist. Links must match student, academic cycle, and Laboratory service. |
| laboratory_checklist_events | id, checklist_id, appointment_id, test_code, old_verified, new_verified, source, reason, actor identity snapshot, created_at. Append-only. |

A replacement does not copy clinical facts into independent rows or erase the predecessor's events. Clinical edits must target the current effective appointment; a stale predecessor URL is read-only.

Checklist progress is authoritative for clinical completion. Persist appointments.status='COMPLETED' only when all its required items are verified, using the same transaction as the final item change. Existing laboratory_results continues to describe document submission/external result handling; it is not repurposed as a second checklist.

Use deferred database checks to enforce that a current published Laboratory appointment has its checklist link and is COMPLETED exactly when all required items are verified. Historical predecessor status remains its historical status even when its shared checklist later completes on a replacement. For internal Laboratory, retain the PENDING_UPLOAD document placeholder when clinical completion opens the existing upload workflow; external verification writes its existing verified-result summary instead.

### 3.3 Mutation rules and corrections

Use a new PATCH /api/appointments/[appointmentId]/laboratory-checklist endpoint with testCode, checked, expectedVersion, and reason when required. Validate a strict payload; the server supplies actor, required tests, and verification source.

Within the transaction:

1. Authorize against the actual appointment and clinic; enforce verified/onboarded staff access.
2. Acquire effective-appointment scope locks and resolve the same-cycle pair in a deterministic order.
3. Lock the checklist and current appointment; compare expectedVersion and reject stale or replaced records.
4. Reject unsupported tests, ended cycles, cancelled/rescheduled appointments, and future appointments.
5. Record the item change, event, version increment, and any derived appointment transition together.
6. Return the authoritative checklist and appointment state.

For ordinary Laboratory, ADMIN and KABALAKA_CLINIC staff may edit. For First-Year/OVPSA external Laboratory, retain ADMIN and CPU_CLINIC staff verification authority in the Physical Examination detail workflow. A nonmatching or null clinic assignment does not gain access.

Require a reason to uncheck a verified test or to correct an automatic no-show. Do not permit unchecking after the paired examination is completed, a certificate is issued, or protected finalized/verified result data exists. Retain existing protection for active draft files and finalized submissions. Verification events remain after any allowed correction.

### 3.4 Partial completion and no-show

Do not add a new appointment status solely for progress. A partly verified Laboratory appointment remains PENDING internally and displays “In progress”. Exclude any checklist with a verified item from automatic no-show marking. An overdue partial checklist displays “In progress — follow-up needed”.

An overdue appointment with no verified items may become NO_SHOW under the existing Manila date policy. A staff correction of that no-show requires a reason; partial verification returns it to PENDING and full verification returns COMPLETED. If a permitted correction removes the last verified item, recompute PENDING versus NO_SHOW from its appointment date and record the transition. Do not clear clinical facts in the midnight worker.

The worker and clinical edits must use compatible locks and recheck item state after acquiring them. Keep First-Year/OVPSA external Laboratory excluded from the no-show worker.

### 3.5 OVPSA and replacement integration

The four required checks represent CPU staff verification of the external results. Completing the final required check writes the existing OVPSA external-verification summary, records its batch/revision/provider provenance, and completes Laboratory in the same transaction. Partial checks do not unlock Physical Examination.

Replace the existing single “verify external Laboratory” action and endpoint with the checklist service. Do not retain an endpoint that can mark all tests verified without recording each test. Retain the existing ovpsa_external_laboratory_verifications table as the completed external verification summary, not a competing writable source.

All replacement writers, including closure recovery, displacement, and OVPSA batch reschedule, must carry checklist links along the retained lineage. Partially verified Laboratory appointments are protected from automatic displacement/recovery that would move or discard recorded work. Route them to Manual Resolution. An explicit manual replacement may move an incomplete appointment when existing result protections allow it; show preserved tests in the preview and retain their original verifiers/timestamps. Completed Laboratory remains protected.

Add LABORATORY_PROGRESS_RECORDED as a protection/manual-case reason in the shared protection types, SQL constraints, closure/displacement classification, API validation, and UI explanation. Automatic workflows must not cancel a partially verified source while creating that case. Existing explicit Manual Resolution can preserve its clinical checklist while assigning a valid replacement; bulk selection still excludes AWAITING_RESCHEDULE cases.

## 4. Physical Examination completion and JPG certificate

### 4.1 Staff workflow

The “Complete examination” action opens one form containing:

- Student name, student number, academic year, college/program/year from the appointment's identity and academic context.
- Date of birth from the student record and calculated age on the actual examination date.
- Actual examination date, defaulting to the scheduled date when valid; it cannot be future, outside the linked cycle, or before the linked Laboratory appointment date.
- Sex as recorded for this examination. The nine-column CSV and current student schema do not supply this field; staff must enter it explicitly rather than infer it. Keep it on the certificate snapshot without changing the required CSV structure.
- Exactly one physician finding: Class A, B, C, or D, with descriptions based on the supplied sample.
- Remarks, optional for A and required for B/C/D.
- Active physician profile: name, license number, specialty when present, and authorized signature.
- An explicit staff attestation that these details reflect the physician's recorded finding.
- A full preview and “Complete examination and issue certificate” save action.

Use radio buttons for Class A–D because these findings are mutually exclusive. No class is preselected. Labels describe the classes from the sample: A unrestricted school activities; B correctible limitations; C restricted activities/follow-up; D unfit for school activities. The actual finding is always entered by staff from the physician's record.

Validate name length (200 characters), sex entry (30), physician name (200), license number (60), specialty (120), and remarks (1000). Reject control characters. Show field errors and layout overflow errors before saving; never silently truncate certificate text.

The appointment must be current, published, within an open cycle, and PENDING or an authorized correction of automatic NO_SHOW. The effective same-cycle Laboratory checklist must be complete, and First-Year/OVPSA must also have its completed external-verification summary. Late encoding requires a reason and an actual examination date; no future completion is permitted.

Use an authorized preview endpoint that runs the same validation and renderer without persisting completion. Preview output is visibly marked “PREVIEW — NOT ISSUED”, is private/no-store, and has no valid issued-certificate number. Editing form values invalidates its preview. The issuance response supplies the actual certificate number and download after the successful transaction.

### 4.2 Physician configuration and template

Add an Administrator settings page for physician profiles. Store profile revisions with a display name, license number, optional specialty, signature image, active flag, actor, and timestamps. A signature upload is an administrator-provided configuration asset, not a student Physical Examination result upload.

Persist normalized signature bytes and profile revisions in PostgreSQL with the certificate data. ADMIN/CPU_CLINIC staff may query an active-physician selection catalog containing profile ID/version, name, license, and specialty; only Administrator configuration and authorized rendering may read raw signature bytes. Profile changes create revisions so in-flight completion can detect stale selections.

Accept PNG or JPEG signature images up to 1 MiB and 4 megapixels after decoding. Normalize them, remove source metadata, and disallow SVG, URLs, and executable content. No fabricated signature, signature extracted from the sample, or preloaded real physician identity is permitted. The fresh installation must configure at least one authorized profile before issuing certificates.

The template follows the sample's blank form structure: medical-certificate title; student name/age/sex; examination date; four classification choices; remarks; physician identity and signature; school-use note; form reference; and a new certificate number. Do not copy the sample patient's details, signed specimen, or approval stamp into source control or output. Use the existing CPU branding asset only as appropriate to the configured template. Do not invent an official stamp.

Use a separately identified digital template version, MEDCLINIC-PE-CERT-v1. Its sample-derived layout does not falsely claim that the photographed paper form's revision number is the software's own approved revision.

### 4.3 Rendering and atomic release

Render a clean landscape A4 JPG at 3508 × 2480 pixels with a white background, 300-DPI metadata, JPEG quality 95, and 4:4:4 chroma sampling. Use the existing sharp 0.35.4 package as a direct production dependency and the repository's bundled font assets. Move sharp from devDependencies to dependencies and update package-lock.json. Do not add a browser screenshot service or generate certificate text with an image model.

Build the layout with escaped text and explicit wrapping. Bundle fonts consistently for the supported Windows installation and deployment host. Never resolve user-provided URLs, CSS, XML entities, or file paths during rendering. Test the exact production runtime's font rendering.

Issue using two stages inside one user action:

1. Authenticate and validate the form; read the appointment, checklist, academic boundary, physician revision, and template version. Build the immutable snapshot, certificate ID, and JPG in memory. Enforce an 8 MiB output ceiling; rendering failure leaves the appointment unchanged.
2. Start a database transaction, acquire the established scope/pair locks, and compare all captured versions and authoritative fields. Revalidate permissions, open cycle, effective Laboratory completion, appointment status, and physician activity. Insert the certificate snapshot and JPEG bytes, mark the examination COMPLETED, update exam_results, write audit/status events, and queue the portal notification plus eligible email outbox item. Commit together.

Store the final bytes in PostgreSQL BYTEA, with a SHA-256 checksum and byte length. Downloads return these issued bytes, so later name, physician, or template edits cannot change an already issued certificate. Keep JPEG bytes out of list queries, application logs, audit metadata, and emails. This choice increases database/backup size but removes the file-versus-database publication failure window; monitor size in the deployment rehearsal.

Use a client-generated requestId with a server-calculated canonical payload hash. A retry with the same actor/requestId and payload returns the original certificate. Reuse with changed content returns 409. A unique active-certificate constraint prevents two staff issuing twice for the same appointment. A lost response must not require re-entering a clinical completion.

SMTP delivery remains asynchronous; its failure never rolls back completion. Notifications link to the authenticated student portal and contain no classification, medical remarks, or signature.

### 4.4 Certificate persistence, download, and correction

Add medical_certificate_revisions with certificate_id, appointment_id, revision_number, supersedes_revision_id, status ISSUED/SUPERSEDED/REVOKED, immutable student/examination/physician snapshots, classification A/B/C/D, template_version, jpeg_bytes, byte_length, sha256, issued_by identity snapshot, issued_at, and request identity. Enforce one ISSUED revision per appointment and unique (certificate_id, revision_number). Store request outcomes in a small clinical_mutation_requests table, unique by actor and requestId, including action and canonical payload hash.

A current published completed examination must have exactly one issued certificate revision and exam_results.result_status='COMPLETED' at transaction commit, and an issued revision requires those matching completed records. Revocation requires no issued revision, a noncompleted appointment status, and exam_results.result_status='REQUIRES_FOLLOW_UP'. Enforce these relationships with deferred database consistency checks between appointments, exam_results, and certificate revisions. Generic PATCH status=COMPLETED and the old quick-status action cannot bypass issuance.

Use authenticated downloads:

- GET /api/student/medical-certificates/[certificateId]/download: verified active student, ownership check on every request.
- GET /api/medical-certificates/[certificateId]/download: ADMIN or CPU_CLINIC staff with clinical access.
- Return image/jpeg, Content-Disposition attachment with a server-generated safe filename, Cache-Control private, no-store, and X-Content-Type-Options nosniff.
- No public file under public/, no unauthenticated certificate URL, and no public QR verification feature in this revision.
- A revoked certificate returns 410 to its owner; an unrelated user receives the normal non-disclosing not-found response. Default download resolves the current issued revision only.

Allow ADMIN/CPU_CLINIC staff to correct certificate details with a required reason and expected current revision. Correction creates a new JPEG and revision, superseding the prior version atomically; it does not silently overwrite historical bytes. Old revisions remain available to authorized staff history, not student download.

An Administrator can revoke an incorrectly recorded completion with a required reason. Revocation marks its certificate REVOKED, records audit/status events, and returns the appointment to PENDING or NO_SHOW according to the Manila date policy, with exam_results updated consistently. Students receive a generic portal notification. Already downloaded copies cannot be erased; the portal must clearly label the revoked issue. After the year ends, revocation remains allowed as an audited correction, but new clinical completion or substantive certificate replacement does not.

### 4.5 Replace Physical Examination uploads completely

Keep /student/results as the combined entry point, with distinct Laboratory documents and Physical Examination certificate sections. Physical Examination shows its completion/finding summary and a download button, never an upload/edit/resubmit control.

Remove Physical Examination support from draft creation, multipart upload, file deletion, finalize, submit-changes, admin invalidation, ZIP/export queries, submission-profile calculations, and upload-specific copy. Shared routes remain for Laboratory only; crafted requests containing PHYSICAL_EXAM or a Physical Examination appointment ID must fail without creating submission/file/storage records.

Restrict student_result_submissions.result_type to LABORATORY in the final schema. Remove Physical Examination upload-specific columns, constraints, functions, branches, and unused helpers where no remaining feature uses them. Retain exam_results as an examination result projection whose allowed states are COMPLETED for an issued certificate and REQUIRES_FOLLOW_UP after revocation; before first completion there is no exam_results row. Remove its PENDING_UPLOAD and NOT_APPLICABLE states. Clinical class B/C/D does not imply unfinished attendance or incomplete certificate issuance.

Laboratory uploads retain the current draft/edit/revision/finalization, protected-file, private download, and cleanup-intent lifecycle. A Laboratory upload cannot mark a test checked or complete Physical Examination. Existing OVPSA external verification continues to satisfy its external-document workflow without requiring a duplicate student upload.

Update dashboard, reports, exports, and student/admin result summaries to distinguish examination completion, certificate availability, and Laboratory document submission. Do not equate examination completion or “fully complied” with medical fitness.

## 5. Multiple-student replacement on one chosen date

### 5.1 Selection and preview

Add a selection column and bulk-action bar to the Laboratory and Physical Examination lists. Selection is by appointment ID with expectedUpdatedAt, not by display row number or student number alone.

- Only authorized staff see editable selection controls.
- Each operation contains 1–100 appointments from one service, clinic, and academic year.
- “Select this page” selects only eligible visible rows. Selections can persist across pagination for the same filters, with a visible count and removable review list.
- Changing search, service, clinic, academic year, or other filters clears selection. Sorting may retain it because IDs remain explicit.
- Show why completed, ended-year, cancelled, protected, or First-Year/OVPSA rows are ineligible.
- A manually locked but otherwise eligible ordinary appointment may be explicitly moved by authorized staff, inheriting the lock as today. The preview must disclose the inherited protection.
- Partially checked ordinary Laboratory records may move only through the explicit manual path described in section 3.5; the preview shows which verified tests are retained.

Staff choose one replacement date and enter one reason. Preview lists each student's original date, proposed date, relevant paired date, progress/protection, and conflict reason. Show destination used/maximum capacity, selected incoming count, and resulting occupancy.

Preview does not reserve slots. It makes no appointment, audit-success, status, or notification writes.

### 5.2 Validation and commit

Introduce POST /api/appointments/bulk-replacements/preview and POST /api/appointments/bulk-replacements. The preview accepts appointment IDs with expectedUpdatedAt, one ISO date, and reason. It returns normalized selection, row issues, aggregate capacity, and a server-signed preview token bound to actor, payload, source versions, relevant rule versions, and an expiry 10 minutes later. The commit also carries requestId.

Use a 10-minute token only as proof of the reviewed payload; revalidate live state at commit. Do not treat the token as a capacity reservation.

Use a domain-separated HMAC preview token with a key derived for bulk-replacement-preview from the configured signing secret. It must not be a staff/student session JWT or be accepted by either login/session verifier. Validate actor binding, expiry, and canonical payload before live-state validation.

Persist successful bulk request outcomes in the same clinical_mutation_requests store using a distinct BULK_REPLACEMENT action and the normalized selected IDs/date/reason hash. Keep result IDs in the outcome, not medical data. For a replay of an already successful request, resolve its saved outcome before rejecting the original preview as expired; live authorization is still required.

Apply existing rules to every selected appointment:

- PENDING or NO_SHOW, current effective leaf, published, permitted clinic, and original configured academic cycle.
- Proposed date is after today in Manila, a weekday, open for the service, and inside the original scheduling boundary.
- The replacement date differs from the current appointment date.
- Laboratory remains strictly before Physical Examination. The operation moves only the selected service; it never silently moves the counterpart.
- Respect reservations, finalized results, draft-file protection, clinical progress protection, and retained manual locks.
- Exclude First-Year/OVPSA appointments from this generic operation and link staff to the existing batch reschedule workflow. Do not split its owned reservations or change its authoritative external Laboratory date.
- AWAITING_RESCHEDULE cases remain in the existing Manual Resolution workflow.

A conflict on any selected row blocks the complete operation. Staff must remove conflicting rows or choose another date and preview again. Do not silently skip students or save a partial subset.

Commit under the existing schedule-import queue advisory lock, then acquire effective appointment scopes in sorted student/service order and lock capacity/rule rows consistently with other scheduling writers. Recheck source versions, pair state, checklist versions, closure/reservation rules, academic boundaries, and destination capacity.

Capacity validation is aggregate: destination occupancy excluding selected source IDs that already occupy that destination, plus the number of incoming appointments, must be <= the configured maximum. Never run the old single-row “room remains” check independently for all selected students.

Create every replacement, inherited checklist link/protection, reschedule event, audit event, and authoritative student notification in one transaction. Any failure rolls back all of them. Repeated actor/requestId with the same payload returns the prior operation result; mismatched payload returns 409. Return exact created IDs and count; refresh both lists and calendar occupancy.

## 6. Calendar capacity and hover details

Keep the existing route /settings/clinic-unavailable-dates and unified closure editor. Rename its visible page heading to “Clinic calendar” and update navigation/copy. Closure mutation remains Administrator-only; preserve the existing read-only staff calendar.

### 6.1 Authoritative occupancy

Add a bounded calendar occupancy query for the displayed calendar year and view scope. Do not make one request per date or per student. Use the same capacity-counting helper as imports, manual replacements, and closure recovery.

Internal capacity includes capacity-consuming appointments with statuses DRAFT, PENDING, COMPLETED, and NO_SHOW under current scheduling accounting. Exclude cancelled/rescheduled/awaiting-reschedule records and external OVPSA Laboratory appointments. Protect against double-counting superseded lineage. Student-facing booked counts include only published effective records; show any internal unpublished capacity hold separately rather than pretending it is a named student booking.

Do not reduce true capacity use because of a display filter, college filter, or current-year visibility filter. Current-view tooltips omit ended-year student details; if any hidden record still consumes capacity on a displayed date, disclose its aggregate held count. A display filter must never make a full date appear available.

Group published appointments by college identity from the appointment's academic-year snapshot, then by LABORATORY/PHYSICAL_EXAM and internal/external location. Do not use the student's mutable present college for historical grouping. Count a student with both services on a date once in “unique students” and twice in “appointments”. Grouped service totals reconcile with appointment totals, not necessarily unique students.

First-Year/OVPSA Laboratory bookings are shown as “External Laboratory — Iloilo Mission Hospital”; they do not consume KABALAKA capacity. Display OVPSA reservations separately with their batch/capacity meaning. An internal service reserved for a batch is not generally bookable merely because its numeric capacity has room.

### 6.2 Color rules

| Date state | Visual behavior |
| --- | --- |
| No booked students and no consumed capacity | No occupancy tint. The hover shows zero and configured capacities. |
| At least one booking/hold and neither internal service at maximum | Green occupancy tint. |
| Either internal service has positive configured maximum and used >= maximum | Red occupancy tint; identify the full service. Over-capacity is red with an explicit error label. |
| External bookings only | Green occupancy tint with an “External Laboratory” label; internal occupancy remains 0. |
| Capacity setting missing, inactive, or invalid | Neutral “Capacity not configured”; never green or bookable for that service. |
| Closed, weekend, or batch-reserved date | Explicit closed/weekend/reserved treatment and label; no implication of general availability. |

For mixed states, preserve closure draft/conflict visuals as the dominant day background and show occupancy using a separate compact red/green indicator. Distinguish “Full” from the existing red emergency-closure/error state with text and icons. Today uses an outline; a draft selection is not overwritten by a capacity refresh.

The red-any-service rule deliberately does not mean both services are full. Staff can inspect the service figures before choosing a destination. Never sum Laboratory and Physical Examination capacities into a single ceiling.

Resolve overlapping occupancy states in this order: any known internal service at/over capacity is red; otherwise a missing/invalid internal setting is neutral with its configuration warning; otherwise any booking or capacity hold is green; otherwise no tint. External-only green therefore assumes valid internal capacity configuration. Closure/weekend/reservation styling remains separate and dominant as described above.

### 6.3 Accessible details and refresh

Hover, keyboard focus, or touch-accessible “View day details” opens the same popover containing:

- Date, closure/reservation status, and applicable academic-year labels.
- Unique student total and appointment total.
- Laboratory used/maximum/remaining and Physical Examination used/maximum/remaining.
- Published counts grouped by college and service, plus separate external Laboratory and held-capacity counts.
- Clear text for a full, closed, reserved, or unconfigured service.

Do not include student names, birth dates, test results, classification, or medical remarks in the calendar response. Calendar staff can read the existing unified operational view; this does not grant access to another clinic's clinical details or mutations.

Popover interactions must not toggle a closure draft or lose unsaved edits. Provide an accessible legend and keep details available without a mouse. On narrow screens use a labelled details button, not a hover-only interaction.

Fetch fresh occupancy when the year/view changes, on window focus, after known scheduling or capacity writes, and at a modest 60-second interval while the calendar is visible. Preserve unsaved closure drafts during refresh. API responses use private, no-store; stale colors are never authoritative scheduling validation.

## 7. Automatically hide ended academic years

### 7.1 Boundary and scope

Use appointments.schedule_cycle_start joined to academic_years.start_year. A year ends when the current Manila calendar date is later than its configured closing_date. The closing date itself remains active through 23:59:59 Asia/Manila.

Do not infer the end from the appointment date, browser timezone, calendar January 1, or a hardcoded May/June date. Do not set appointments.is_published=FALSE, delete appointments, or manufacture replacement history to hide records.

Add an explicit visibility scope to current readers:

- CURRENT excludes ended cycles.
- YEAR(startYear) selects a specific academic year for history.
- A history listing can span years, but service pairing and “overall completion” must remain within the same academic year and schedule pair.

Apply scope before window ranking in current-effective-appointments.repository.ts. Partition by student, cycle, and service/pair as needed. A current Physical Examination must never be paired with last year's completed Laboratory. If several unended cycles exist, show cycle-labelled records; summaries default to the most recent cycle that has started, with a selectable year. Future prepared schedules stay visibly labelled by their own cycle.

### 7.2 Affected surfaces

Default current scope applies to Laboratory/Physical Examination lists and counts, appointment summary, dashboard operational metrics, current student Schedule/Results sections, current calendar bookings, and open operational work queues.

Offer “Current” and a specific “Academic year” filter on staff schedule/summary pages. An ended year produces a clearly labelled historical view. Student Schedule and Results include a “Previous academic years” section with owned appointment history, finalized Laboratory documents, and issued certificate downloads.

Historical Reports continue to use their explicit selected academic year and immutable snapshots. Do not globally change a shared CTE in a way that empties historical reports. An old bookmarked detail page remains readable after authorization and displays “Academic year ended — historical record”.

Ended-year appointments cannot enter bulk replacement, clinical checkbox edits, ordinary completion, or schedule recovery. Closed-year records do not return to active queues because their attendance status is PENDING or NO_SHOW. Certificate revocation remains an explicit audited correction; download/history remains available.

Update the no-show worker to finish genuine zero-progress overdue appointments at the year boundary without waking old records into current views. Its closing sweep may record historical status; it must not issue replacement tasks or new upcoming-schedule notices for closed years. Partial tests remain recorded and are not relabelled no-show.

### 7.3 Refresh and failure behavior

Evaluate the boundary on the server for every relevant request and write. Revalidate current client views after Manila midnight, on focus, and after academic-year settings change. There must be no dependency on a cron job successfully setting an “archived” flag.

Use the existing academic-year service's supported edit restrictions. If an allowed closing-date change moves a boundary, visibility follows the stored boundary on the next refresh. Audit the configuration change.

A missing academic-year link is an integrity failure. Surface an administrative error, block clinical/scheduling mutation, and do not silently treat the appointment as current or erase it from historical diagnostics. Fresh import publication must require the valid academic-year/snapshot link.

## 8. Shared authorization, consistency, and audit requirements

| Actor | Permitted work in this revision |
| --- | --- |
| Administrator | Both clinic scopes, checklist verification, authorized certificate issuance/correction/revocation, bulk replacements, physician configuration, calendar edits, academic-year configuration, and history. |
| KABALAKA clinic staff | Assigned internal Laboratory checklists and eligible manual/bulk Laboratory replacements; existing calendar read access. No Physical Examination clinical records or certificate issuance. |
| CPU clinic staff | Physical Examination completion/certificate issuance/correction, eligible ordinary PE replacements, and existing OVPSA external-result verification; existing calendar read access. |
| Coordinator | Retained import/onboarding/report capabilities only. No newly granted clinical mutation, bulk clinical list access, certificate access, or physician configuration. |
| Verified active student | Own schedules, Laboratory submissions, own issued JPG certificate, and authorized historical records. |

Recheck database-backed active sessions and clinic assignment at each API boundary and service mutation. Student IDs in URLs are never authorization. Preserve existing staff onboarding and student email-verification gates. Permission checks precede byte retrieval and medical-data responses.

Use compatible lock ordering across imports, replacements, checklist updates, completion/certificate issuance, closures, and no-show processing. Database constraints enforce required identity links, unique active lineage/certificates, valid class/test enums, and nonempty required data. Transactions use existing helpers; do not introduce nested independent commits.

Scheduling writers take the existing global scheduling advisory lock first. All writers then acquire relevant effective student/service scope locks in sorted order before appointment pair rows, checklist rows, and applicable capacity/configuration rows. Clinical writers need not take the global scheduling lock but must follow the shared scope/row order. Adapt the no-show worker to acquire or skip the matching scope before row locks; it must not first hold an appointment row while waiting on a checklist already held by a clinical writer. Revalidate any academic/physician/closure versions used before rendering or preview under the final transaction's locks.

Every clinical edit, completion, correction, revocation, and replacement records actor identity, relevant version, old/new state, and reason where required. Keep medical text and signature bytes out of generic notification/audit payloads; protected certificate revisions carry the medical content. Staff deletion must retain historical actor labels according to the existing deletion policy.

## 9. File boundaries for implementation

Create focused modules instead of adding all behavior to appointments.service.ts or ClinicUnavailableCalendar.tsx.

| New module/path | Responsibility |
| --- | --- |
| src/server/laboratory/laboratory-requirements.ts | Pure year/category test applicability and requirement version. |
| src/server/laboratory/laboratory-checklist.repository.ts | Checklist identity, items, events, lineage links, version locks. |
| src/server/laboratory/laboratory-checklist.service.ts | Authorized verification/correction, derived status, OVPSA summary. |
| src/components/appointments/LaboratoryChecklist.tsx | Accessible progress editing and conflict/error state. |
| src/server/medical-certificates/certificate-schema.ts | Strict completion/profile/correction input and immutable snapshot types. |
| src/server/medical-certificates/certificate-renderer.ts | Deterministic layout and validated JPEG rendering from trusted snapshots. |
| src/server/medical-certificates/certificate.repository.ts | Private bytes, revisions, checksums, profile revisions, request outcomes. |
| src/server/medical-certificates/certificate.service.ts | Completion/issuance/correction/revocation transactions and access policy. |
| src/components/appointments/PhysicalExamCompletionForm.tsx | Finding, physician selection, preview, attestation, and one save action. |
| src/components/medical-certificates/CertificateDownload.tsx | Authorized download and issued/revoked state. |
| src/app/(dashboard)/settings/medical-certificate-physicians/page.tsx | Administrator physician/signature configuration. |
| src/server/appointments/bulk-replacement.service.ts | Preview, aggregate revalidation, atomic commit, and request deduplication. |
| src/components/appointments/BulkReplacementDialog.tsx | Selected-student review, date/reason, preview conflicts, and save. |
| src/server/schedule/scheduling-occupancy.repository.ts | Shared capacity accounting used by calendar and scheduling writes. |
| src/server/services/calendar-occupancy.service.ts | Scoped calendar aggregates, college/service grouping, color state. |
| src/components/settings/clinic-calendar/CalendarDayDetails.tsx | Keyboard, touch, and hover details without closure mutation. |
| src/server/appointments/academic-year-visibility.ts | Shared server predicate/input scope and Manila boundary semantics. |

Proposed API additions, all with strict payloads and explicit authorization:

- /api/appointments/[appointmentId]/laboratory-checklist
- /api/appointments/[appointmentId]/complete-physical-exam
- /api/appointments/[appointmentId]/physical-exam-certificate-preview
- /api/appointments/bulk-replacements/preview
- /api/appointments/bulk-replacements
- /api/clinic-calendar/occupancy
- /api/medical-certificates/[certificateId]/download
- /api/medical-certificates/[certificateId]/revisions
- /api/medical-certificates/[certificateId]/revoke
- /api/student/medical-certificates/[certificateId]/download
- /api/medical-certificate-physicians (read-only active selection catalog)
- /api/settings/medical-certificate-physicians and its profile-specific update route

Modify existing list/detail pages, AppointmentActions, status labels, appointment pair/protection helpers, imports and every replacement writer, the no-show worker, student/admin result pages and services, result-profile calculations, dashboard/tracking repositories, historical report queries/exports, academic-year readers, clinic calendar page/component, and notification builders.

Remove AppointmentQuickStatusButton.tsx and its obsolete behavior tests once all completion consumers use the new controls. Remove the old quickStatusAction parser/branches and the superseded all-at-once external verification route/component. Retain generic appointment PATCH for still-supported cancellation/lock/replacement operations; reject clinical completion there. Do not keep deprecated completion actions behind hidden buttons.

## 10. Fresh-database schema and rollout

Add database/migrations/028_final_defense_clinical_workflows.sql after the existing 027 baseline. It creates checklist/certificate/profile/request tables and their constraints/indexes, narrows upload schema to Laboratory, and changes Physical Examination result semantics. Update the empty-database rehearsal's explicit migration count/end-name from 27/027 to 28/028.

Create medical_certificate_physicians and medical_certificate_physician_revisions explicitly for configuration and immutable signature revisions. Index checklist links by checklist_id, verified items by checklist_id, certificate metadata by (student_number, academic_year_start), and appointment list/occupancy access by cycle/date/clinic/service using the existing indexes where sufficient. Never index or include JPEG bytes in covering list indexes.

The migration must fail with an explicit unsupported-preexisting-clinical-data error if old operational records would require guessing checklist findings, clinical classes, or certificates. Do not fabricate completion evidence or silently delete existing records. In this project's authorized fresh-install context, that guard is expected to pass with zero clinical data.

Retain historical migrations as an auditable chain; do not rewrite 001–027 or introduce a second bootstrap schema. Historical SQL that is superseded by 028 is migration history, while the final schema and active application have one supported workflow. Do not build legacy data backfill, compatibility routes, or dual-write paths for an undeployed system.

The final schema must reject Physical Examination rows in student_result_submissions and any unsupported result upload state. Update existing fixtures that manufacture completed Laboratory/Physical Examination rows so they create valid checklists and certificates. Enforce consistency at transaction commit so incomplete intermediate inserts are allowed within a transaction but contradictory final records are rejected.

First-install reference seed remains reference-only. Seed no real clinical results, issued certificates, or signatures. Physician setup is an explicit administrator installation step. Preserve SMTP/outbox keys, private Laboratory storage, academic-year configuration, and staff bootstrap/onboarding.

Update README.md, docs/installation.md, database/README.md, docs/e2e.md, and docs/current-policies.md during implementation. Mark affected older design sections as superseded by this spec when the behavior is implemented; do not label the current application as already changed merely because this proposal was committed.

Relevant superseded guidance includes July 16 automatic no-show behavior for partial Laboratory work, July 23/29/30 completion controls, July 31 completion locking, and August 6 Physical Examination upload behavior. Preserve still-valid Laboratory file revision, authorization, and storage requirements from those records.

## 11. Implementation sequence and acceptance gates

This is a design and implementation handoff, not authorization to deploy. Implement in these dependency groups after review:

1. Schema, clinical requirements, checklist lineage, and shared current-year/occupancy definitions.
2. Laboratory UI/API, OVPSA verification, partial-progress/no-show protections, and replacement-link propagation.
3. Physician setup, certificate rendering, atomic examination issuance, downloads/corrections/revocation, and complete removal of PE uploads.
4. Bulk selection/preview/atomic replacements using the shared rules.
5. Calendar occupancy/details and current-versus-historical views across affected pages.
6. Documentation, dead-path removal, and a complete fresh installation rehearsal.

The following are required behavioral acceptance cases, not claims of tests already run.

### Laboratory and examination

- Year 1 and fourth-year OJT require four checks; second/third year and fourth-year Regular/Tour require three.
- Later student/year/category edits do not alter an earlier appointment's requirement snapshot.
- A submitted Laboratory file never toggles a test. Partial progress never completes Laboratory or unlocks PE.
- Final applicable verification completes Laboratory once; stale/double requests cannot duplicate events.
- External partial verification does not create a completed OVPSA summary; the final check creates it atomically.
- Ordinary and external clinic permissions are tested with matching, nonmatching, null-scope, coordinator, unverified, deleted, and student sessions.
- Midnight sweep and checkbox writes racing cannot erase progress or mark a partly verified Laboratory as no-show.
- Partial progress is preserved through allowed manual replacement; automatic recovery/displacement protects it; a new academic year does not inherit it.
- Checklist rollback is blocked once downstream examination/certificate or protected results exist.
- Old status=COMPLETED, quickStatusAction, and external bulk-verification payloads cannot bypass the new clinical APIs.

### Certificates and uploads

- Class is required and mutually exclusive; no finding defaults to A. B/C/D require remarks and remain completed examinations.
- Missing sex, invalid examination date, missing physician/signature, stale physician version, incomplete Laboratory, or ended cycle prevents issuance.
- Render failure, constraint failure, and notification-outbox insertion failure leave both completion and issued certificate absent.
- Preview is watermarked, makes no issue/completion writes, and never exposes a raw signature URL; changed form values require a fresh preview.
- SMTP send failure after commit preserves the issued certificate and queues retry.
- Simultaneous/retried completion creates one issue; altered requestId payload receives 409.
- Files decode as JPG, have exactly 3508 × 2480 pixels and 300-DPI metadata, and meet the output-size ceiling.
- Visually inspect all four classes, long Filipino names, middle names/suffixes, ñ/apostrophes, multiline remarks, physician signature, and Windows/deployment fonts.
- A later student/physician/template edit does not change stored bytes. Corrections make explicit revisions; revocation disables student download and updates result/attendance consistently.
- Students cannot access another student's certificate. Unauthorized staff cannot download clinical bytes.
- Every PE upload route and forged payload is rejected; Laboratory upload/edit/finalization/private downloads and cleanup remain functional.
- Closed-year certificates and finalized Laboratory files remain accessible through authorized history.

### Bulk replacements

- Move 1 and 100 eligible appointments to one date; reject 101 and duplicate IDs.
- Preview does not write. Selection cannot silently expand across filters or include unreviewed students.
- Exact remaining capacity succeeds; one appointment over capacity blocks the entire group.
- One stale, unauthorized, protected, wrong-year, OVPSA, wrong-service, past/weekend/closed/reserved, or pair-order-invalid item blocks all replacements.
- A Laboratory move cannot silently move PE; a PE move preserves its completed Laboratory.
- Competing imports, capacity edits, closures, and bulk saves never overbook; source versions and preview expiry are rechecked.
- Repeated requestId returns the same IDs with no duplicate reschedule history or notifications.
- A successful bulk request replay after preview expiry still returns its saved result, after authorization and payload-hash checks.
- An error on the final selected student leaves no earlier selected student moved.

### Calendar and ended years

- Zero, partly booked, exactly full, overfull, one-service-full, external-only, missing-capacity, closed, and reserved dates render the specified labels and colors.
- Unique student totals differ correctly from appointment totals; college/service totals reconcile.
- A college change does not rewrite historical college counts. External Laboratory never consumes internal capacity.
- Display filters and hidden years cannot reduce authoritative used capacity.
- Hover/focus/touch details work without toggling closures; refresh preserves unsaved closure drafts.
- Closing date remains current in Manila; the next day hides appointments consistently across lists/counts/dashboard/portal/calendar.
- Browser timezone does not change the boundary. Open tabs refresh after midnight without needing a worker archive job.
- Current pairing cannot borrow completed Laboratory from an ended year, and explicitly selected historical reports remain populated.
- No history, notification record, result document, or certificate is deleted as part of automatic hiding.

### First-deployment rehearsal

Run the repository's lint, unit/component suites, integration suites on disposable PostgreSQL, TypeScript check, production build, and npm run test:migrations:empty. Update the migration rehearsal to verify new constraints and that rerunning db:migrate is a no-op.

Rehearse the documented installation: empty database, all migrations, reference seed, first Administrator bootstrap, staff onboarding/email delivery, capacities, academic year, physician setup, standard and First-Year/OVPSA imports, clinical work, certificate download, bulk replacements, calendar closure/recovery, and ended-year history. Restore a database backup and private Laboratory storage together; verify certificate bytes/checksums survive the restore.

Run a production-dependency-only smoke test of certificate rendering after moving sharp to dependencies. Do not depend on test-only fonts, dev packages, browser screenshot services, sample medical records, or files in scratch directories.

A successful implementation has no active PE upload acceptance path, no clinical-completion bypass, no competing checklist source, no duplicate certificate issuance, and no current/history scope leakage.

## 12. Reference and review notes

- The supplied photographed medical certificate was visually reviewed for layout and field structure. The photograph and its personal/clinical content are intentionally not included in this repository document.
- sharp output reference: https://sharp.pixelplumbing.com/api-output/ — JPEG options and metadata controls.
- sharp installation reference: https://sharp.pixelplumbing.com/install/ — production platform and font/runtime considerations.
- Existing current policy index: docs/current-policies.md.
- Existing first-deployment authority: docs/superpowers/specs/2026-09-07-repository-review-first-deployment-design.md.

This spec's recommended defaults should be reviewed before implementation, especially authorized signature configuration, all-or-nothing bulk behavior, red-any-service calendar meaning, and retained access to ended-year history. Implementation must follow the confirmed workflow choices in section 1 and cannot silently reintroduce the superseded UI/API behavior.
