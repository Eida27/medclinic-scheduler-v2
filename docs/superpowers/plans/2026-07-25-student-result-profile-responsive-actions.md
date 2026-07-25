# Responsive Student Result Submission Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent current Laboratory and Physical Exam result cards from overflowing their boundaries while improving the administrator submission-action interface.

**Architecture:** Keep the existing two-service page grid and make each `StudentResultSection` card an inline-size container. Finalized content stacks by default and switches to files/actions columns only when that card reaches Tailwind's 42rem `@2xl` container threshold. Preserve every existing submission-ID API, validation rule, confirmation, refresh, audit, and authorization behavior.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4 container queries, Vitest, Testing Library.

## Global Constraints

- Keep the outer `xl:grid-cols-2` Laboratory/Physical Exam layout.
- Do not modify server APIs, database code, repositories, services, or result-profile data contracts.
- Preserve the ZIP URL and accessible name `Download {resultLabel} ZIP for appointment {appointmentDate}, submission {submissionIndex}`.
- Preserve the invalidation button accessible name `Invalidate {resultLabel} and reopen upload` and the result-specific field label `{resultLabel} invalidation reason`.
- Preserve the required invalidation reason limits: minimum 3 and maximum 1,000 characters.
- Preserve confirmation-dialog, conflict, retry, refresh, and request-body behavior.
- Use visible action copy `Download all files (ZIP)`, `Submission actions`, `Reopen student upload`, and `Invalidate and reopen upload`.
- Do not merge, push, or create a pull request.

---

### Task 1: Make the current result cards container-responsive

**Files:**
- Modify: `src/components/admin-results/AdminSubmissionActions.test.tsx`
- Modify: `src/components/admin-results/AdminSubmissionActions.tsx`
- Modify: `src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx`
- Modify: `src/components/admin-results/StudentResultSection.tsx`

**Interfaces:**
- `AdminSubmissionActions` keeps its existing `Props` type and submission-ID request routes.
- `StudentResultSection` keeps accepting `{ section: AdminCurrentResultSection }`.
- The action panel exposes an accessible region named `{resultLabel} submission actions`.
- The reason control becomes a four-row `<textarea>` while keeping its existing accessible label, name, required state, and length limits.

- [ ] **Step 1: Add failing action-panel tests**

Extend `AdminSubmissionActions.test.tsx` so the Laboratory render asserts:

```tsx
const actions = screen.getByRole("region", { name: "Laboratory submission actions" });
const reason = within(actions).getByLabelText("Laboratory invalidation reason");
expect(reason.tagName).toBe("TEXTAREA");
expect(reason).toHaveAttribute("rows", "4");
expect(reason).toHaveAttribute("minlength", "3");
expect(reason).toHaveAttribute("maxlength", "1000");
expect(reason).toBeRequired();
expect(within(actions).getByText("Submission actions")).toBeVisible();
expect(within(actions).getByText("Download all files (ZIP)")).toBeVisible();
expect(within(actions).getByText("Reopen student upload")).toBeVisible();
expect(within(actions).getByText("Invalidate and reopen upload")).toBeVisible();
expect(actions).toHaveClass("min-w-0");
```

Keep the existing request, confirmation, retry, conflict, and Physical Exam assertions.

- [ ] **Step 2: Add failing page-level responsive-contract tests**

In the finalized Laboratory page test, assert:

```tsx
const section = screen.getByRole("region", { name: "Laboratory results" });
expect(section.firstElementChild).toHaveClass("@container");
expect(within(section).getByText("Finalized").parentElement).toHaveClass("justify-self-start");
expect(within(section).getByText("laboratory.pdf")).toHaveClass("break-words");
expect(within(section).getByRole("region", { name: "Laboratory submission actions" }))
  .toHaveClass("min-w-0");
```

Locate the finalized files/actions layout using a stable test id `current-result-content` and assert that it has both `min-w-0` and `@2xl:grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)]`.

- [ ] **Step 3: Run focused tests and verify the red state**

Run:

```powershell
npm test -- "src/components/admin-results/AdminSubmissionActions.test.tsx" "src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx"
```

Expected: the new assertions fail because the current reason control is an `<input>`, there is no named action region, and the card still uses viewport-based `lg:grid-cols-[1fr_320px]`.

- [ ] **Step 4: Implement the bounded action panel**

In `AdminSubmissionActions.tsx`:

- Replace `Input` with `Textarea` and set `rows={4}`, `name="reason"`, `minLength={3}`, `maxLength={1000}`, and `required`.
- Render the root as `<section aria-label={`${resultLabel} submission actions`}>` with `min-w-0`, rounded border, canvas background, padding, and a compact grid gap.
- Add visible heading `Submission actions` and helper text `Download finalized files, or invalidate this submission to let the student upload a replacement.`.
- Keep the ZIP link's existing `href` and `aria-label`, change only its visible text to `Download all files (ZIP)`, and constrain it with `w-full max-w-full whitespace-normal text-center`.
- Add a bordered subsection labelled `Reopen student upload` above the existing form.
- Keep the result-specific `Field` label.
- Give the submit button `aria-label={`Invalidate ${resultLabel} and reopen upload`}` and visible text `Invalidate and reopen upload`; use `h-auto min-h-11 w-full whitespace-normal py-3 text-center leading-snug`.
- Do not change any event handler, fetch request, dialog, error, pending, or refresh logic.

- [ ] **Step 5: Implement the container-responsive result card**

In `StudentResultSection.tsx`:

- Add `@container` to the outer `Card`.
- Wrap the state badge in `<div className="justify-self-start">` so it remains pill-sized.
- Replace `lg:grid-cols-[1fr_320px]` with a finalized-content grid carrying `data-testid="current-result-content"`, `min-w-0`, and `@2xl:grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)]`.
- Add `min-w-0` to the files column and action column boundary.
- Make each file card a container-aware grid that stacks by default and uses `@sm:grid-cols-[minmax(0,1fr)_auto]` when the result card is at least 24rem wide.
- Add `min-w-0` to filename containers, `break-words` to filenames, and `max-w-full whitespace-normal break-words text-center` to individual download links.
- Do not change URLs, accessible labels, metadata, state handling, or history rendering.

- [ ] **Step 6: Run focused tests and verify green**

Run the focused command from Step 3.

Expected: 2 test files and all tests pass.

- [ ] **Step 7: Self-review and commit**

Run:

```powershell
git diff --check
git status --short
```

Confirm only the plan, two production components, and their two test files changed. Commit with:

```powershell
git add docs/superpowers/plans/2026-07-25-student-result-profile-responsive-actions.md src/components/admin-results/AdminSubmissionActions.tsx src/components/admin-results/AdminSubmissionActions.test.tsx src/components/admin-results/StudentResultSection.tsx "src/app/(dashboard)/settings/student-result-submissions/students/[studentNumber]/page.test.tsx"
git commit -m "fix: contain student result submission actions"
```

Expected: one focused implementation commit.

---

## Controller Verification

After task review and final whole-branch review:

```powershell
npm test -- --maxWorkers=1 --no-file-parallelism
npm run lint
npm run build
git diff --check main...HEAD
```

Use the in-app Browser at 724x590, 1365x768, and 1920x1080. At every size, assert document and result-card `scrollWidth <= clientWidth`; at 1365x768 retain two service cards with internally stacked content; at 1920x1080 confirm the `@2xl` internal two-column layout. Enter a Laboratory reason, open the confirmation dialog, verify it, and cancel without submitting the invalidation. Confirm zero Browser console warnings/errors and reset the temporary viewport.
