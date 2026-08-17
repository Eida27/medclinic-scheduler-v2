# Schedule Import Year-Level / Category Validation Design

**Date:** 2026-08-17  
**Status:** Approved design  
**Scope:** Schedule CSV import validation, active category cleanup, and import-form guidance only

## 1. Objective

Prevent admins and coordinators from importing student CSV files under a category that does not match the students' year level, while keeping the current scheduling rules unchanged after validation succeeds.

The implementation must also retire the `Specialized` category from the fresh, undeployed system and add clear import guidance to `/students/schedule-imports/new`.

## 2. Approved Business Rules

Each CSV import must contain students from exactly one year level and one category group.

| CSV Year Level | Allowed Category |
| --- | --- |
| Year 1 | First Year only |
| Year 2 | Regular only |
| Year 3 | Regular or Tour |
| Year 4 | OJT only |

Additional rules:

- Supported year levels are only 1, 2, 3, and 4.
- A CSV containing more than one year level must be rejected.
- Year 3 students participating in Tour must be placed in a separate Tour CSV from Year 3 students remaining Regular.
- The system must not infer Tour participation from year level. The selected category applies to the whole CSV.
- The system must never silently change the selected category.
- `Specialized` is retired completely from the active system because the application has not yet been deployed.

## 3. Specialized Retirement

`Specialized` must no longer be a valid active category.

The implementation should remove it from:

- schedule-import category unions/types;
- `/students/schedule-imports/new` dropdown options;
- active server-side validation schemas;
- active scheduling/category branches;
- relevant filters and assignment controls;
- seeds/reference data where it is exposed as an active category;
- test fixtures and test cases that depend on it;
- development database enum/schema definitions where applicable.

Because this is a fresh, undeployed development system, preserving historical `Specialized` records is not required. However, the cleanup must remain focused and must not redesign unrelated database structures.

## 4. Import Form Guidance

Inside the existing CSV instructions box on `/students/schedule-imports/new`, add a visible disclaimer before the file-selection workflow.

Recommended copy:

> **CSV Import Reminder**  
> Prepare a separate CSV file for each student group before importing. Each CSV must contain students from only **one year level** and **one category**.  
> **Year 1 → First Year**  
> **Year 2 → Regular**  
> **Year 3 → Regular or Tour**  
> **Year 4 → OJT**  
> For Year 3, prepare separate CSV files for students joining the **Tour** and students remaining **Regular**.

The active category choices shown in the form must be:

- Regular
- First Year
- OJT
- Tour

`Specialized` must not appear.

## 5. Validation Architecture

Use **Approach B: server-side preflight validation plus final authoritative validation**.

Introduce one centralized server-side policy unit responsible only for validating the relationship between parsed CSV rows and the selected import intent.

A suitable contract is conceptually:

```ts
validateScheduleImportYearCategory({
  rows,
  importMode,
  studentCategory,
});
```

Its responsibilities are:

1. derive distinct year levels from parsed rows;
2. reject unsupported year values outside 1 through 4;
3. reject files containing more than one year level;
4. enforce the approved year/category matrix;
5. return or throw a structured application validation error;
6. remain independent from appointment generation, displacement, publication, and database writes.

This logic must not live in the low-level CSV parser. The parser should continue handling file structure and row parsing only.

## 6. Preflight Endpoint

Add a dedicated endpoint such as:

```text
POST /api/schedule-imports/preflight
```

The endpoint must:

- require the same Admin/Coordinator authorization as schedule import;
- accept the same multipart form data needed to identify the CSV and selected category/import mode;
- validate the file and parse rows using existing CSV parsing logic;
- run the centralized year/category policy;
- return success when the combination is valid;
- return HTTP 422 using the application's existing error shape when invalid;
- perform no database writes.

## 7. Review Flow

When the user clicks **Review import**:

1. Validate the CSV structure/file requirements.
2. Run preflight validation.
3. Apply validation priority:
   - unsupported year values;
   - mixed year levels;
   - year/category mismatch.
4. If preflight fails:
   - keep the confirmation dialog closed;
   - show the existing danger alert/error UI;
   - stop processing.
5. If preflight succeeds:
   - Regular / OJT / Tour: open the normal confirmation dialog;
   - First Year: continue into the existing First Year review flow, then open confirmation only when that review can publish.

The user-selected category must never be auto-corrected or auto-switched.

## 8. First Year Compatibility Behavior

The existing UI currently represents the visible First Year option through a special import mode while retaining an internal Regular compatibility category.

The new policy validator must therefore identify First Year intent using `importMode === "FIRST_YEAR_OVPSA"`, not by treating the internal `studentCategory === "REGULAR"` value as a normal Regular import.

Existing First Year requirements remain unchanged:

- Year 1 only;
- OVPSA-specific workflow;
- Iloilo Mission Hospital laboratory location;
- explicit First Year Laboratory Date;
- existing date ownership, displacement, and publication behavior.

## 9. Category-Specific Scheduling Inputs

Do not change existing scheduling input behavior after validation succeeds.

- **Regular:** no Preferred Month.
- **Tour:** Preferred Month remains required.
- **OJT:** Preferred Month remains required.
- **First Year:** uses the First Year Laboratory Date and does not use Preferred Month.

The new feature is validation and category cleanup, not a redesign of scheduling priority or placement rules.

## 10. Final Import Enforcement

The final `POST /api/schedule-imports` path must run the same centralized year/category policy again before any write-capable import/scheduling operation proceeds.

This second validation is authoritative and must prevent bypass through direct API requests.

On mismatch, no new scheduling side effects may occur, including:

- schedule import group creation;
- appointment publication;
- displacement;
- scheduling audit publication;
- downstream import-generated records.

Preflight exists for UX; final server validation exists for data integrity.

## 11. Validation Error Priority

Only the highest-priority applicable policy error should be shown for a given review attempt.

### Unsupported Year

Recommended message:

> **Invalid year level detected.** Schedule imports only support Year 1, Year 2, Year 3, and Year 4 students. Please correct the CSV before continuing.

### Mixed Year Levels

This takes priority over category mismatch errors.

Recommended message:

> **Mixed year levels detected.** Each CSV import must contain students from only one year level. Please separate the students into different CSV files before importing.

Do not also list category mismatch messages for the same mixed-year file.

### Category Mismatch Messages

**Year 1 with Regular, OJT, or Tour:**

> This CSV contains Year 1 students. Select **First Year** in Student category before continuing.

**Year 2 with First Year, OJT, or Tour:**

> This CSV contains Year 2 students. Year 2 students can only be imported as **Regular**.

**Year 3 with First Year or OJT:**

> This CSV contains Year 3 students. Select **Regular** or **Tour** before continuing.

**Year 4 with First Year, Regular, or Tour:**

> This CSV contains Year 4 students. Year 4 students can only be imported as **OJT**.

If `Specialized` is submitted manually after its retirement, it must be rejected as an invalid category rather than accepted by hidden/API-only behavior.

## 12. UI Error Behavior

Reuse the form's existing error alert rather than introducing a second notification system.

Requirements:

- invalid preflight must not open the confirmation dialog;
- category mismatch should be associated with the Student category field when practical using the existing structured `fields` error shape;
- changing the selected CSV file clears stale import/category validation errors;
- changing Student category clears stale category-validation errors;
- First Year review state should be reset when relevant inputs change.

## 13. Test Plan

### Policy Unit Tests

Cover at minimum:

- Year 1 + First Year -> allowed;
- Year 1 + Regular/OJT/Tour -> rejected;
- Year 2 + Regular -> allowed;
- Year 2 + First Year/OJT/Tour -> rejected;
- Year 3 + Regular -> allowed;
- Year 3 + Tour -> allowed;
- Year 3 + First Year/OJT -> rejected;
- Year 4 + OJT -> allowed;
- Year 4 + First Year/Regular/Tour -> rejected;
- mixed year levels -> rejected with mixed-year result;
- Year 0, Year 5, or other unsupported values -> rejected;
- retired `Specialized` -> rejected.

### Preflight API Tests

Verify:

- valid combinations return success;
- invalid combinations return 422;
- mixed-year files return only the mixed-year policy error;
- missing/invalid files continue using existing CSV validation behavior;
- no database writes occur.

### Final Import API / Service Tests

Verify:

- direct wrong-category submissions are rejected even if preflight is bypassed;
- rejection happens before import/scheduling writes;
- valid combinations continue through existing scheduling behavior.

### UI Tests

Verify:

- `Specialized` is absent from the dropdown;
- the disclaimer contains the year/category mapping;
- an invalid Review import attempt shows the error and keeps confirmation closed;
- changing the file/category clears stale mismatch errors;
- valid Regular/OJT/Tour reviews proceed to confirmation;
- valid First Year reviews continue through the existing First Year review path.

### Fixture Updates

Existing unrelated tests that use Year 4 with `REGULAR` must be updated to a valid Regular year level, normally Year 2 or Year 3, when the test is not specifically testing category validation.

Do not weaken the new rule to preserve obsolete fixtures.

## 14. Acceptance Criteria

The feature is complete when all of the following are true:

1. Year 1 imports are accepted only as First Year.
2. Year 2 imports are accepted only as Regular.
3. Year 3 imports are accepted only as Regular or Tour.
4. Year 4 imports are accepted only as OJT.
5. Every CSV contains exactly one year level.
6. Years outside 1 through 4 are rejected.
7. Mixed-year files stop at the mixed-year error and do not also show category mismatch errors.
8. `Specialized` is removed from active system behavior and cannot be submitted through the API.
9. The import form shows the approved CSV separation/year-category disclaimer.
10. Review import validates on the server before confirmation.
11. Final import repeats the same authoritative policy before write-capable scheduling work.
12. The system never auto-switches the user's selected category.
13. Year 3 Tour and Year 3 Regular remain separate CSV import groups chosen explicitly by the admin/coordinator.
14. OJT and Tour Preferred Month behavior remains unchanged.
15. First Year OVPSA/Iloilo Mission Hospital behavior remains unchanged.
16. Regular FCFS, capacity, displacement, manual-resolution, notification, audit, and role authorization behavior remain unchanged unless directly required by the validation gate.
17. Focused tests, the full test suite, lint, and build pass after implementation.

## 15. Out of Scope

This design does not authorize changes to:

- scheduling priority algorithms beyond preventing invalid imports;
- First Year ownership/displacement policy;
- OJT or Tour scheduling windows;
- Regular FCFS behavior;
- emergency closure/manual resolution policy;
- notification content except where existing import error presentation is reused;
- unrelated schema refactors;
- automatic category inference or automatic category switching.

## 16. Implementation Guidance for Codex

When implementation begins, Codex should:

- follow the existing project patterns and error model;
- centralize year/category policy in one server-side unit;
- use that policy in both preflight and final import paths;
- reuse existing CSV parsing rather than implementing a second parser;
- preserve current First Year special-mode compatibility intentionally;
- remove `Specialized` comprehensively but only within relevant category/scheduling scope;
- update obsolete tests/fixtures rather than weakening requirements;
- run focused tests first, then the complete test suite, lint, and build;
- summarize changed files and verification results after implementation.

No implementation is included in this design document.
