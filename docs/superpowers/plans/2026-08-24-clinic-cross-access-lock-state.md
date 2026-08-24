# Clinic Cross-Access Lock State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the expected top-level cross-clinic runtime error with an explanatory lock state while preserving clinic authorization and preventing cross-clinic appointment loading.

**Architecture:** Each top-level clinic page recognizes only the known valid opposite-clinic staff assignment and returns a shared server component before authorization assertion, search-parameter parsing, or repository access. Every other user continues through the existing `assertClinicAccess` and schedule-loading paths unchanged.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Tailwind CSS, Vitest 4, Testing Library, PostgreSQL, and the in-app Browser.

**Spec:** `docs/superpowers/specs/2026-08-24-clinic-cross-access-lock-state-design.md`

## Global Constraints

- Use exact approved headings and messages from the spec.
- The friendly state applies only to KABALAKA staff on `/physical-exam` and CPU staff on `/laboratory`.
- Return before `assertClinicAccess`, `searchParams`, and `listAppointments` only for those two combinations.
- Preserve authorized CPU/KABALAKA staff and Admin schedule behavior, filters, sorting, pagination, and Laboratory-status projection.
- Keep `assertClinicAccess`, `Sidebar.tsx`, `forbidden.tsx`, deeper routes, APIs, repositories, auth/session types, and database schema unchanged.
- Keep both clinic sidebar links visible and clickable.
- Run every production behavior through a failing test before implementation.
- Do not push, create a PR, merge to `main`, or remove the worktree.

---

### Task 1: Shared restricted component and Physical Exam branch

**Files:**
- Create: `src/components/clinic/ClinicAccessRestricted.tsx`
- Modify: `src/app/(dashboard)/physical-exam/page.tsx`
- Modify: `src/app/(dashboard)/physical-exam/page.test.tsx`

**Interfaces:**
- `ClinicAccessRestricted` consumes `{ title: string; message: string }`.
- Its one inline SVG uses `aria-hidden="true"` and `data-testid="clinic-access-lock"`.

- [ ] Add a KABALAKA staff test that expects `Physical Exam access restricted`, the exact KABALAKA message, one lock SVG, no normal schedule/filter/student content, and no calls to `assertClinicAccess` or `listAppointments`; run it and confirm RED.
- [ ] Add Admin normal-access and invalid/missing-clinic rejection tests that preserve the existing assertion and repository boundary.
- [ ] Add the shared responsive server component using existing MedClinic Tailwind tokens, an `h1`, explanatory paragraph, and one prominent inline lock SVG.
- [ ] Add the narrow KABALAKA-staff early return before assertion, parameter parsing, and appointment access; leave the authorized path unchanged.
- [ ] Run the serialized Physical Exam test file, self-review, and commit the green slice.

### Task 2: Laboratory branch and navigation regression

**Files:**
- Modify: `src/app/(dashboard)/laboratory/page.tsx`
- Modify: `src/app/(dashboard)/laboratory/page.test.tsx`
- Verify: `src/components/layout/Sidebar.test.tsx`

**Interfaces:**
- Reuse `ClinicAccessRestricted` without adding another predicate or component.

- [ ] Add a CPU staff test that expects `Laboratory access restricted`, the exact CPU message, one lock SVG, no normal schedule/filter/student content, and no calls to `assertClinicAccess` or `listAppointments`; run it and confirm RED.
- [ ] Add Admin normal-access and invalid/missing-clinic rejection tests.
- [ ] Add the narrow CPU-staff early return before assertion, parameter parsing, and appointment access; leave the authorized path unchanged.
- [ ] Run both serialized page tests plus `Sidebar.test.tsx`, self-review, and commit the green slice.

### Task 3: Authenticated Browser acceptance and completion proof

**Files:**
- No tracked production or fixture files.

- [ ] Start the app in this worktree and prepare one guarded synthetic CPU clinic staff account only in the loopback local database; refuse to overwrite an existing fixture identity.
- [ ] In the in-app Browser, sign in as KABALAKA staff, verify `/laboratory`, click Physical exam, and check exact copy, sidebar, one SVG lock, absent data/controls, responsive layout, and console/runtime cleanliness.
- [ ] Sign in as CPU staff, verify `/physical-exam`, click Laboratory, and check the equivalent restricted flow.
- [ ] Sign in as Admin and verify both schedules remain normal.
- [ ] Remove exactly the synthetic CPU account and prove zero fixture residue.
- [ ] Run the serialized focused tests, serialized full suite with extended timeouts and dot reporter, lint, production build, and `git diff --check`.
- [ ] Complete a final whole-branch code review, address findings, and commit locally without integrating.
