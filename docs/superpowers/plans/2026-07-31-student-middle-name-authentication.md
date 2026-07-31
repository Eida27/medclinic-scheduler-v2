# Student Middle-Name Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a student's complete middle name as the third student-portal credential and reject schedule-import rows that omit it.

**Architecture:** Extend the existing student-login request, repository credential record, and transactional authentication service without changing the session or database schema. Enforce the CSV requirement at the existing parser boundary and verify the real login/import flows with a guarded synthetic Browser fixture.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod, PostgreSQL, Vitest, Testing Library, in-app Browser.

## Global Constraints

- Keep `students.middle_name` nullable for legacy data; add no migration or normalized-name column.
- Preserve Student Number normalization, rate-limit keys and timings, session/cookie contents, and the exact nine-column CSV header.
- Middle-name authentication is case-insensitive only: do not trim, collapse spaces, remove punctuation, or accept initials.
- Use TDD for behavior changes and the repository `npm test` wrapper for verification.
- Do not push, create a PR, merge into `main`, or remove the worktree without a separate request.

---

### Task 1: Student login UI and route contract

**Files:**
- Create: `src/components/student/StudentLoginForm.test.tsx`
- Create: `src/app/(student)/student/login/page.test.tsx`
- Create: `src/app/api/student-auth/login/route.test.ts`
- Modify: `src/components/student/StudentLoginForm.tsx`
- Modify: `src/app/(student)/student/login/page.tsx`
- Modify: `src/app/api/student-auth/login/route.ts`

**Interfaces:** `POST /api/student-auth/login` consumes `{ studentNumber, dateOfBirth, middleName }`; `middleName` is a required, non-transforming string of at most 100 characters.

- [ ] Write failing component, page, and route tests for control order, required plain-text behavior, exact payload preservation, approved copy, pending state, validation before authentication, and generic credential errors.
- [ ] Run the focused tests and confirm each fails because the feature is absent.
- [ ] Add the Middle Name input after DOB, submit its untouched value, update the page copy, and add non-transforming route validation.
- [ ] Run the focused tests to green and commit the slice.

### Task 2: Transactional middle-name authentication

**Files:**
- Modify: `src/server/repositories/student-auth.repository.ts`
- Modify: `src/server/services/student-auth.service.ts`
- Modify: `src/server/services/student-auth.integration.test.ts`
- Modify: `src/server/auth/student-session.test.ts`

**Interfaces:** `authenticateStudent(input)` adds `middleName: string`; the repository credential record adds `middleName: string | null`; `StudentSession` remains unchanged.

- [ ] Write failing integration tests for exact/case-varied success, every spacing/punctuation/initial mismatch, legacy null middle names, inactive/unknown students, DOB mismatch, attempt increments, lockout, successful clearing, and minimal sessions.
- [ ] Run the focused tests and confirm the expected failures.
- [ ] Select `middle_name`, validate without transformation, compare with `toLowerCase()` only, and return the approved generic error.
- [ ] Run authentication and session tests to green and commit the slice.

### Task 3: Required CSV middle names and compatibility fixtures

**Files:**
- Modify: `src/server/services/student-import-csv.ts`
- Modify: `src/server/services/student-import-csv.test.ts`
- Modify affected schedule-import/API/E2E/Browser CSV fixtures
- Modify: `README.md`

**Interfaces:** `ImportedStudentRow.middleName` becomes `string`; blank cells produce `rows.N.Middle Name: ["Middle Name is required."]`.

- [ ] Write failing blank/whitespace parser tests and a downloadable-template behavior test.
- [ ] Run the parser tests and confirm the expected failures.
- [ ] Require Middle Name after existing cell trimming while retaining internal spaces and the 100-character limit.
- [ ] Give every valid CSV fixture a complete middle name; retain blanks only in explicit rejection fixtures and update affected database expectations.
- [ ] Update README login and CSV guidance, run the import regression set to green, and commit the slice.

### Task 4: Guarded Browser acceptance and final verification

**Files:**
- Create: `scripts/browser-student-middle-name-auth-fixture.ts`
- Create: `src/test/browser-student-middle-name-auth-fixture.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:** `npm run acceptance:student-auth -- prepare|status|cleanup`; all mutating modes require a loopback PostgreSQL URL and `STUDENT_AUTH_ACCEPTANCE_EXCLUSIVE_DATABASE=1`.

- [ ] Write failing fixture tests for database guards, generated blank-middle CSV, preparation state, and cleanup proof.
- [ ] Implement one disposable full-middle-name student plus prepare/status/cleanup modes and add the package command/documentation.
- [ ] Run fixture tests and prepare a dedicated local acceptance database.
- [ ] In the in-app Browser, verify login copy/control order, required validation, preserved-space generic rejection, case-varied success, minimal response/session, blank-middle import rejection, and zero console warnings/errors.
- [ ] Clean the fixture and prove zero fixture students, attempts, or imports remain.
- [ ] Run the serialized full suite, lint, build, and `git diff --check`; review the diff and leave the committed feature branch for review.
