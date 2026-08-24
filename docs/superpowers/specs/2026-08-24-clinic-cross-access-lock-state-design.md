# Clinic Cross-Access Lock State Design

Date: 2026-08-24
Status: Approved design
Repository: `Eida27/medclinic-scheduler-v2`
Reviewed against main commit: `7059a149362dfcf19b013e3bb8e32d0e7bce6bc0`

## 1. Purpose

Replace the current runtime-error experience when a clinic staff member opens the schedule page assigned to the other clinic with an intentional, clinic-specific locked-access page.

The existing clinic ownership model remains unchanged:

- KABALAKA Clinic owns the Laboratory workflow.
- CPU Clinic owns the Physical Examination workflow.
- `CLINIC_STAFF` may manage only the clinic assigned to their account.
- `ADMIN` may access both clinic workflows.

The current top-level clinic pages call `assertClinicAccess(...)`. When a clinic staff account opens the other clinic's page, `assertClinicAccess(...)` throws `CLINIC_ACCESS_DENIED`, which currently surfaces as a Next.js runtime error during development.

This design changes only the expected top-level cross-clinic navigation experience. It does not weaken clinic authorization or provide access to the other clinic's data.

## 2. Current Repository Review

This design was re-reviewed after the user's latest local changes were pushed to GitHub.

Current reviewed main commit:

```text
7059a149362dfcf19b013e3bb8e32d0e7bce6bc0
fix: close email notification review gaps
```

The repository is 21 commits ahead of the earlier `ff99dcc3f3451ecc9b0ce17e45c13654c80dcabe` snapshot. Those pushed changes primarily implement mandatory student email verification, schedule email notifications, delivery monitoring, related tests, and supporting authorization behavior.

The clinic cross-access area remains compatible with the approved design:

- `src/server/clinic-access.ts` still throws `CLINIC_ACCESS_DENIED` for a non-admin whose `clinicCode` does not match the requested clinic.
- `src/app/(dashboard)/physical-exam/page.tsx` still calls `assertClinicAccess(user, "CPU_CLINIC")` before loading appointments.
- `src/app/(dashboard)/laboratory/page.tsx` still calls `assertClinicAccess(user, "KABALAKA_CLINIC")` before loading appointments.
- `src/components/layout/Sidebar.tsx` still keeps both `Laboratory` and `Physical exam` visible to clinic staff.
- `src/components/layout/Sidebar.test.tsx` already asserts that clinic staff receive both links.
- A new global `src/app/forbidden.tsx` now exists for generic 403 handling, but it is intentionally not the approved UX for this expected cross-clinic navigation case.

No conflict was found that requires changing the approved Option A behavior.

## 3. Approved User Experience

Option A is the approved behavior.

Both **Laboratory** and **Physical exam** remain visible and clickable in the clinic staff sidebar.

Do not hide, disable, redirect, or visually lock the opposite-clinic sidebar link. The explanation appears on the destination page after the clinic staff member clicks it.

The normal dashboard shell, including the sidebar, should remain visible around the restricted-state content.

### 3.1 KABALAKA Clinic staff opening Physical Exam

When an authenticated `CLINIC_STAFF` account assigned to `KABALAKA_CLINIC` opens:

```text
/physical-exam
```

render a normal in-application restricted state instead of throwing the page-level `CLINIC_ACCESS_DENIED` error.

Required copy:

**Heading**

```text
Physical Exam access restricted
```

**Message**

```text
This account is assigned to KABALAKA Clinic. You can only access the Laboratory tab.
```

The page must show one prominent inline SVG lock icon.

The page must not display or load:

- Physical Examination appointment rows;
- student names;
- appointment counts;
- filters;
- sorting controls;
- pagination;
- status controls;
- any CPU Clinic schedule details.

### 3.2 CPU Clinic staff opening Laboratory

When an authenticated `CLINIC_STAFF` account assigned to `CPU_CLINIC` opens:

```text
/laboratory
```

render the same shared restricted-state presentation with CPU-specific copy.

Required copy:

**Heading**

```text
Laboratory access restricted
```

**Message**

```text
This account is assigned to CPU Clinic. You can only access the Physical Exam tab.
```

The page must show the same SVG lock treatment and must not load or display KABALAKA appointment data.

### 3.3 Allowed clinic access remains unchanged

- `KABALAKA_CLINIC` staff opening `/laboratory` see the existing Laboratory schedule normally.
- `CPU_CLINIC` staff opening `/physical-exam` see the existing Physical Examination schedule normally.
- `ADMIN` users continue to access both pages normally.

## 4. Authorization Matrix

| User | `/laboratory` | `/physical-exam` |
|---|---|---|
| `ADMIN` | Normal schedule | Normal schedule |
| `CLINIC_STAFF` + `KABALAKA_CLINIC` | Normal schedule | Clinic-specific lock state |
| `CLINIC_STAFF` + `CPU_CLINIC` | Clinic-specific lock state | Normal schedule |
| `CLINIC_STAFF` + invalid/missing clinic assignment | Existing authorization rejection | Existing authorization rejection |
| `COORDINATOR` | Preserve existing route/navigation protection | Preserve existing route/navigation protection |

The lock state is only for the two known, valid cross-clinic combinations. It is not a general replacement for authorization failures.

## 5. Security Boundary

The UI change must not weaken the existing authorization model.

Keep `assertClinicAccess(user, clinicCode)` as the authoritative throwing authorization helper for cases that should be rejected.

Do not change it to:

- return a Boolean instead of throwing;
- silently accept another clinic;
- swallow invalid clinic assignments;
- convert every authorization error into a lock page;
- grant clinic staff cross-clinic read or write access.

The top-level pages should detect only the narrow expected case before calling the existing assertion:

```text
requireUser()
  -> known CLINIC_STAFF assigned to opposite valid clinic?
       yes -> return ClinicAccessRestricted immediately
       no  -> assertClinicAccess(user, targetClinic)
                  -> authorized -> load normal schedule
                  -> unauthorized -> existing rejection
```

This preserves defense-in-depth while making the normal sidebar cross-click understandable to clinic staff.

## 6. Do Not Use the Generic Forbidden Page for This Case

The current repository contains:

```text
src/app/forbidden.tsx
```

That page provides the generic message:

```text
403
Access denied
You do not have permission to view this page.
```

It remains appropriate for generic authorization failures, including the newer dashboard/student authorization behavior.

Do not route the approved cross-clinic clinic-staff case through `forbidden()` because:

- the approved messages identify the staff member's assigned clinic;
- the approved messages tell the staff member exactly which tab they may use;
- the requested experience needs a prominent lock SVG;
- the sidebar should remain available so the staff member can navigate directly to the allowed clinic page;
- a valid cross-clinic tab click is an expected application state rather than a malformed authentication state.

The generic forbidden page and the new clinic-specific restricted component have separate responsibilities.

## 7. Shared Restricted-State Component

Create one reusable component for both clinic pages.

Recommended path:

```text
src/components/clinic/ClinicAccessRestricted.tsx
```

Recommended interface:

```ts
type ClinicAccessRestrictedProps = {
  title: string;
  message: string;
};
```

The component should be a normal server-compatible React component. No client-side state, effect, or JavaScript interaction is required.

### 7.1 Visual requirements

The restricted state should:

- occupy the primary page content area cleanly;
- center the core message horizontally and visually within a generous vertical area;
- render one large inline SVG lock icon;
- render the supplied title as the page's `h1`;
- render the explanatory message directly below it;
- use existing Tailwind utilities and MedClinic design tokens;
- remain responsive on desktop and mobile;
- preserve the surrounding `DashboardShell` and sidebar.

Keep the UI intentionally simple. Do not add unrelated illustrations, animation, modal behavior, extra cards, or a second navigation system.

Conceptual hierarchy:

```text
              [ SVG LOCK ]

      Physical Exam access restricted

This account is assigned to KABALAKA Clinic.
You can only access the Laboratory tab.
```

The CPU/Laboratory state uses the same component with different text.

### 7.2 SVG accessibility

Use an inline SVG rather than an external asset.

Preferred treatment:

```tsx
<svg aria-hidden="true" ...>
```

because the adjacent `h1` and explanatory text already communicate the meaning. The SVG should not create redundant screen-reader announcements.

Tests may expose a stable test selector on the lock container/icon if necessary, but do not compromise semantics solely for testing.

## 8. Physical Examination Page Flow

Modify:

```text
src/app/(dashboard)/physical-exam/page.tsx
```

The target remains:

```ts
const clinic = clinicConfigs.CPU_CLINIC;
```

Required flow:

1. Call `requireUser()` exactly as the page does today.
2. Before `assertClinicAccess(...)`, detect the approved opposite-clinic case:
   - `user.role === "CLINIC_STAFF"`
   - `user.clinicCode === "KABALAKA_CLINIC"`
3. If true, immediately return `ClinicAccessRestricted`.
4. Use the exact approved Physical Exam heading and KABALAKA message.
5. Do not await or parse `searchParams` in the restricted branch unless React/Next.js implementation constraints require it.
6. Do not call `listAppointments(...)` in the restricted branch.
7. For all other users, preserve `assertClinicAccess(user, clinic.code)`.
8. Preserve the current parsing, sort behavior, pagination, filters, `includeLaboratoryStatus`, and `ClinicPublishedSchedule` output for authorized users.

The restricted decision must happen before appointment repository access.

## 9. Laboratory Page Flow

Modify:

```text
src/app/(dashboard)/laboratory/page.tsx
```

The target remains:

```ts
const clinic = clinicConfigs.KABALAKA_CLINIC;
```

Required flow:

1. Call `requireUser()` exactly as the page does today.
2. Before `assertClinicAccess(...)`, detect the approved opposite-clinic case:
   - `user.role === "CLINIC_STAFF"`
   - `user.clinicCode === "CPU_CLINIC"`
3. If true, immediately return `ClinicAccessRestricted`.
4. Use the exact approved Laboratory heading and CPU Clinic message.
5. Do not parse schedule filters in the restricted branch unless technically necessary.
6. Do not call `listAppointments(...)` in the restricted branch.
7. For all other users, preserve `assertClinicAccess(user, clinic.code)`.
8. Preserve existing sort, pagination, filter, and `ClinicPublishedSchedule` behavior for authorized users.

## 10. Sidebar Contract

Current sidebar behavior already matches Option A.

`src/components/layout/Sidebar.tsx` keeps these primary links available to `CLINIC_STAFF`:

```text
Dashboard
Laboratory
Physical exam
Students & Schedules
```

Keep both clinic links unchanged.

Do not:

- hide the restricted link;
- disable the restricted link;
- replace it with non-clickable text;
- add a sidebar lock icon;
- change the link path;
- redirect the link to the staff member's assigned clinic.

The destination lock page is the explanation mechanism.

The newer `Email delivery` administrator link introduced by the email-notification work is unrelated and must remain untouched.

## 11. Data Loading and Information Exposure

A restricted page must stop before querying the other clinic's appointment list.

Required invariants:

### KABALAKA staff on Physical Exam

```text
listAppointments(...) must not be called
```

for a KABALAKA clinic staff request to `/physical-exam`.

### CPU Clinic staff on Laboratory

```text
listAppointments(...) must not be called
```

for a CPU clinic staff request to `/laboratory`.

This avoids both unnecessary work and accidental cross-clinic data exposure.

The lock page must not include:

- student identity information;
- other-clinic appointment counts;
- other-clinic dates;
- other-clinic status totals;
- other-clinic filters or query results.

## 12. Existing Deeper Route Protection

This design intentionally targets the two top-level schedule pages that are reachable from the shared sidebar.

Deeper appointment routes and mutation endpoints remain protected by their existing authorization behavior.

For example, appointment detail currently checks the authenticated user and prevents clinic staff from viewing an appointment whose `clinicId` differs from the user's assigned `clinicId`.

Do not weaken or remove those checks as part of this feature.

The clinic-specific lock screen does not imply that a staff member may browse, query, or manipulate the other clinic through direct URLs or APIs.

If a future requirement asks for clinic-specific lock states on deeper routes, design that separately rather than expanding this bounded change implicitly.

## 13. Error Handling

The two valid cross-clinic tab combinations are expected UI states and should no longer throw a page-rendering `CLINIC_ACCESS_DENIED` error.

All unexpected cases continue through existing authorization behavior.

Examples that should **not** be converted automatically into the friendly clinic lock screen:

- missing `clinicCode` on clinic staff;
- unknown/invalid clinic code;
- a non-clinic-staff role reaching a clinic-only path outside its existing permissions;
- unauthenticated request;
- disabled/expired user session;
- direct unauthorized mutation request.

These retain the current server protection path.

## 14. Testing Requirements

Use the repository's existing Vitest and React Testing Library patterns.

### 14.1 Physical Examination page

Modify:

```text
src/app/(dashboard)/physical-exam/page.test.tsx
```

Add a KABALAKA clinic staff fixture and verify:

- `requireUser()` resolves that staff account;
- the page renders `Physical Exam access restricted`;
- the exact approved KABALAKA message is visible;
- the SVG lock is present through a stable semantic/test selector;
- `listAppointments` is not called;
- the normal `Published physical examination schedule` heading is absent;
- schedule filters/table content are absent;
- the restricted branch does not expose CPU Clinic appointment data.

Retain the current tests for:

- CPU Clinic staff normal access;
- filter handling;
- pagination;
- Laboratory status column behavior.

Add or preserve an administrator case proving Admin still receives normal Physical Examination access.

### 14.2 Laboratory page

Modify:

```text
src/app/(dashboard)/laboratory/page.test.tsx
```

Add a CPU Clinic staff fixture and verify:

- the page renders `Laboratory access restricted`;
- the exact approved CPU Clinic message is visible;
- the SVG lock is present;
- `listAppointments` is not called;
- the normal `Published laboratory schedule` heading is absent;
- no Laboratory appointment data is exposed.

Retain current coverage for:

- KABALAKA normal access;
- filtering;
- pagination;
- unsupported-sort fallback.

Add or preserve an administrator case proving Admin still receives normal Laboratory access.

### 14.3 Sidebar regression

The current sidebar tests already verify that clinic staff receive both:

```text
/laboratory
/physical-exam
```

Keep that assertion.

No production change to `Sidebar.tsx` should be required for this feature.

If test fixtures are updated to include `clinicCode`, keep both links visible.

### 14.4 Authorization regression

Add focused coverage where useful to prove an invalid/missing clinic assignment still reaches the existing `assertClinicAccess(...)` rejection path instead of being mistaken for one of the two approved lock states.

The feature must distinguish:

```text
known opposite clinic -> friendly lock state
invalid authorization -> existing rejection
```

## 15. Verification Commands

Codex should use test-driven development and run the focused tests first.

Recommended focused command:

```bash
npm test -- src/app/\(dashboard\)/physical-exam/page.test.tsx src/app/\(dashboard\)/laboratory/page.test.tsx src/components/layout/Sidebar.test.tsx
```

If shell path escaping differs on Windows, run the files individually through the repository's existing `npm test -- <path>` pattern.

Before completion, run the repository-wide checks defined in `package.json`:

```bash
npm test
npm run lint
npm run build
```

Any existing environment-dependent integration or browser-fixture requirements should be handled according to the repository's established setup rather than bypassed.

## 16. Files Expected to Change

### Create

```text
src/components/clinic/ClinicAccessRestricted.tsx
```

### Modify

```text
src/app/(dashboard)/physical-exam/page.tsx
src/app/(dashboard)/physical-exam/page.test.tsx
src/app/(dashboard)/laboratory/page.tsx
src/app/(dashboard)/laboratory/page.test.tsx
```

### Modify only if test-fixture maintenance is necessary

```text
src/components/layout/Sidebar.test.tsx
```

### Intentionally unchanged

```text
src/server/clinic-access.ts
src/components/layout/Sidebar.tsx
src/app/forbidden.tsx
src/app/(dashboard)/layout.tsx
src/components/appointments/AppointmentDetail.tsx
database migrations
appointment repository query semantics
authentication/session schema
student email verification and notification implementation
```

A tiny shared predicate may be introduced only if it materially improves clarity, but avoid unnecessary abstraction for two explicit clinic combinations.

## 17. Non-Goals

This feature does not:

- give KABALAKA staff access to CPU Clinic data;
- give CPU Clinic staff access to KABALAKA data;
- change scheduling priorities;
- change displacement rules;
- change emergency closure behavior;
- change Manual Resolution behavior;
- change First Year OVPSA scheduling;
- change student email verification;
- change email notification delivery;
- change database schema;
- redesign the dashboard;
- hide either clinic tab;
- introduce a redirect to the allowed clinic page;
- replace generic 403 handling across the application;
- change deeper appointment/API authorization unless required to preserve an existing invariant.

## 18. Acceptance Criteria

The implementation is accepted when all of the following are true:

1. KABALAKA clinic staff can open `/laboratory` normally.
2. KABALAKA clinic staff opening `/physical-exam` see a normal dashboard page instead of the AppError/Next.js runtime overlay.
3. The restricted Physical Exam state shows one prominent SVG lock.
4. It shows `Physical Exam access restricted`.
5. It shows `This account is assigned to KABALAKA Clinic. You can only access the Laboratory tab.`
6. The restricted Physical Exam request does not call `listAppointments(...)`.
7. CPU Clinic staff can open `/physical-exam` normally.
8. CPU Clinic staff opening `/laboratory` see the corresponding normal dashboard lock state.
9. The restricted Laboratory state shows one prominent SVG lock.
10. It shows `Laboratory access restricted`.
11. It shows `This account is assigned to CPU Clinic. You can only access the Physical Exam tab.`
12. The restricted Laboratory request does not call `listAppointments(...)`.
13. Admin continues to access both clinic schedule pages normally.
14. Both Laboratory and Physical exam remain visible and clickable in the clinic staff sidebar.
15. Invalid or unexpected authorization states remain protected by existing server authorization behavior.
16. The generic `src/app/forbidden.tsx` behavior remains unchanged.
17. Deeper appointment and mutation protections remain unchanged.
18. No database migration is added.
19. Focused tests pass.
20. Repository-wide test, lint, and build verification completes successfully or any pre-existing/environment-specific failure is explicitly documented rather than hidden.

## 19. Codex Implementation Guidance

Treat this as a bounded UI/access-flow change. Avoid unrelated refactoring.

Recommended TDD order:

1. Add the failing KABALAKA-on-Physical-Exam test.
2. Add the failing CPU-on-Laboratory test.
3. Assert in both tests that `listAppointments` is not called.
4. Create `ClinicAccessRestricted` with the inline SVG lock and accessible page structure.
5. Add the narrow early-return condition to `physical-exam/page.tsx`.
6. Add the narrow early-return condition to `laboratory/page.tsx`.
7. Add Admin and invalid-assignment regression coverage as needed.
8. Run the focused page and sidebar tests.
9. Run `npm test`.
10. Run `npm run lint`.
11. Run `npm run build`.

The implementation must preserve this invariant:

> A known valid clinic staff member may see an explanatory restricted page for the other clinic's top-level sidebar tab, but must never receive that clinic's appointment data or management capability.
