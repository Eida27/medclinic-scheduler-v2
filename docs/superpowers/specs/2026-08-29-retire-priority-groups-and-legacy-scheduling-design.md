# Retire Priority Groups and Legacy Scheduling Architecture

Date: 2026-08-29
Repository: `Eida27/medclinic-scheduler-v2`
Baseline branch: `main`
Baseline commit inspected: `e4643e610b67cee275995287904558ebc235e9fb`
Status: Approved design; implementation not started

## Summary

The scheduling subsystem currently contains two generations of architecture:

1. the current atomic CSV scheduling flow used by `POST /api/schedule-imports`; and
2. an older manual/staged workflow built around `priority_groups`, coordinator schedule batches, explicit validate/generate/publish phases, and a generic rank-based scheduler.

This design retires the second architecture completely. The system will keep one authoritative scheduling path: atomic Schedule Imports.

The cleanup is intentionally subtractive. It removes obsolete configuration, APIs, services, routes, tests, and dead rule-engine code while preserving the current scheduling behavior for Regular, Tour, OJT, and First-Year/OVPSA imports.

## Decisions Approved

The following decisions are authoritative for implementation:

- Remove `priority_groups` completely as a configurable domain concept.
- Keep current category-based displacement behavior. Removing `priority_groups` must not remove valid priority/displacement rules for Regular, Tour, OJT, and First-Year/OVPSA scheduling.
- Retire the entire legacy/manual `/coordinator-schedules` workflow.
- Retire the staged `DRAFT -> VALIDATED -> GENERATED -> PUBLISHED` schedule-import lifecycle.
- Delete retired compatibility APIs instead of keeping `410 Gone` shims.
- Delete the obsolete dashboard `/coordinator-schedules` route tree instead of preserving redirects.
- Remove dead generic rule-engine pieces such as `generate-schedule.ts` and `priority-rules.ts` when repository-wide usage proves they are legacy-only.
- Preserve historical migrations `001` through `025`; add a new forward-only migration `026`.
- Do not introduce a replacement configurable-priority table or compatibility mapping.
- Correct README documentation so `SPECIALIZED` is no longer presented as a supported category.

## Current Supported Scheduling Contract

The surviving scheduling contract is:

- Import modes: `STANDARD`, `FIRST_YEAR_OVPSA`.
- Student categories: `REGULAR`, `OJT`, `TOUR`.
- First-Year/OVPSA uses the existing compatibility category behavior already implemented by the current service.
- Scheduling remains date-only and Monday-Friday in Manila.
- Laboratory must precede Physical Examination.
- Current capacity, locks, protected-appointment rules, clinic-closure behavior, and category-based displacement remain unchanged.

The implementation must follow the current year/category policy in code. It must not reintroduce `SPECIALIZED`, K-12 scope, or any previously discarded scheduling model.

## Target Architecture

After implementation, the only supported schedule-creation flow is:

```text
Students -> Schedule Imports
        |
        v
POST /api/schedule-imports
        |
        v
schedule-imports.service
        |
        +--> standard atomic scheduler
        |
        +--> First-Year/OVPSA scheduler
                  |
                  v
       paired scheduling + capacity
                  |
                  v
       category-based displacement
                  |
                  v
 PostgreSQL imports / batches / schedule items / appointments
                  |
                  v
 publication + authoritative notifications
```

There must be no alternate manual or staged route around this pipeline.

## API Design

### Retain

The following schedule-import APIs remain authoritative:

- `GET /api/schedule-imports` — list schedule-import history.
- `POST /api/schedule-imports` — validate and atomically schedule a CSV import.
- `POST /api/schedule-imports/preflight` — preflight validation.
- `POST /api/schedule-imports/review` — First-Year/OVPSA review flow.
- `GET /api/schedule-imports/[importId]` — schedule-import detail/history.

Normal appointment APIs used for reads, status changes, locks, clinic operations, and other current behavior remain untouched.

### Delete

Delete these retired API surfaces completely so they naturally resolve as 404:

```text
/api/priority-groups

/api/coordinator-schedules
/api/coordinator-schedules/*

/api/appointments/generate
/api/appointments/publish

/api/schedule-imports/[importId]/validate
/api/schedule-imports/[importId]/generate
/api/schedule-imports/[importId]/publish
```

Do not retain redirect handlers, deprecation handlers, or `410 Gone` compatibility responses for these routes.

## Service and Repository Design

### `schedule-imports.service.ts`

Keep the current atomic import responsibilities, including:

- request/file validation;
- `preflightScheduleImport()`;
- `reviewFirstYearScheduleImport()`;
- `acceptAndScheduleImport()`;
- import listing and import-detail reads;
- current CSV parsing and year/category validation.

Remove staged-lifecycle responsibilities, including:

- `validateScheduleImport()`;
- `generateScheduleImport()`;
- `publishScheduleImport()`;
- staged result types;
- helpers used exclusively by the staged lifecycle;
- imports from `coordinator-schedules.service.ts` that exist only for staged scheduling;
- publication helpers that become unused after staged lifecycle removal.

### `coordinator-schedules.service.ts`

Delete this service after repository-wide usage confirms no surviving caller outside the retired workflow or obsolete tests/fixtures.

Any reusable behavior that is genuinely required by the atomic architecture must be retained in an appropriate surviving module rather than preserving the legacy service wholesale.

### Reference data

Reference Data remains a valid feature for:

- colleges;
- academic programs.

Remove all configurable priority-group support:

- `PriorityGroup` type;
- `listPriorityGroups()`;
- `"priorityGroup"` variants in generic reference CRUD;
- priority-group validation schema;
- priority-group create/update/delete SQL;
- priority-group API tests and callers.

The current Reference Data page should continue to manage only colleges and programs.

### Schedule-import repository/read model

Remove priority-group persistence/read-model remnants:

- stop inserting an explicit `NULL` into `coordinator_schedule_items.priority_group_id`;
- remove joins to `priority_groups`;
- remove selection of `priority_group.name`;
- remove `priorityGroupName` from TypeScript result types and API payloads.

Do not replace `priorityGroupName` with a fabricated category value. The old generic priority model and the current category-based scheduling policy are separate concepts.

## Database Design

### Migration strategy

Do not rewrite historical migrations.

Create:

`database/migrations/026_remove_priority_groups_and_legacy_scheduling.sql`

The migration must upgrade an existing database at migration `025` safely and also work as the final step of a fresh `001` through `026` migration chain.

### Schema changes

Migration `026` must:

1. remove the foreign-key dependency associated with `coordinator_schedule_items.priority_group_id` as required by the actual schema;
2. drop `coordinator_schedule_items.priority_group_id`;
3. drop `priority_groups_updated_at` if present;
4. drop `priority_groups`;
5. leave all other scheduling/import/appointment/history tables intact.

Use the real constraint and trigger names from the applied migration chain and appropriate defensive `IF EXISTS` handling where useful.

### Explicitly preserve `coordinator_schedule_items`

Do not drop `coordinator_schedule_items`.

The current atomic scheduler still uses schedule items as provenance between imports/batches and appointments. Only the obsolete priority-group relationship is removed.

### Historical data behavior

Do not delete valid published appointments, batches, schedule-import groups, audit rows, displacement history, or schedule-item provenance merely because they were created while the old schema existed.

Existing development databases may contain obsolete `DRAFT`, `VALIDATED`, or `GENERATED` manual/staged records. Do not attempt to translate or auto-publish them. Their old actions disappear with the retired workflow. Developers who require a pristine local state may use the guarded database reset.

The school production database is expected to start fresh, so it will never need staged-workflow compatibility.

## Rule Engine Cleanup

Do not delete the whole `src/server/rule-engine` directory.

Retain active pieces required by the atomic scheduler, including current paired scheduling and capacity logic such as:

- `generate-paired-schedule.ts`;
- `capacity-rules.ts`;
- their valid tests and dependencies.

Delete legacy generic scheduler pieces when usage analysis proves they become unreachable, including:

- `generate-schedule.ts`;
- `generate-schedule.test.ts`;
- `priority-rules.ts`;
- exports/types used only by those retired files.

Retain current category-based displacement services and tests, including `priority-displacement.service.ts` and First-Year/OVPSA displacement. The word `priority` remains valid where it describes current business behavior rather than the removed `priority_groups` table.

## Dashboard/UI Design

Delete the complete obsolete dashboard tree:

```text
src/app/(dashboard)/coordinator-schedules/
```

This includes:

- root redirect page;
- `/new`;
- `[batchId]`;
- related redirect/page tests.

The canonical scheduling UI remains:

`Students -> Schedule Imports`

Do not redesign that UI as part of this cleanup.

## Retired Workflow Helper

`src/lib/retired-workflows.ts` currently contains more than one unrelated retirement helper.

After retired scheduling routes are deleted:

- remove `schedulingWorkflowRetiredError()` only if repository-wide search proves it has no surviving caller;
- preserve `studentLookupRetiredError()` and any unrelated retired-workflow behavior still used elsewhere.

This cleanup must not expand into unrelated compatibility removals.

## Failure Handling and Transaction Boundaries

The current atomic schedule-import behavior remains all-or-nothing.

The refactor must preserve these invariants:

- malformed CSV/reference/category errors reject before successful scheduling;
- invalid year/category combinations reject;
- capacity and protected-appointment conflicts reject appropriately;
- scheduling lock/concurrency behavior remains intact;
- category displacement remains transactional;
- Laboratory/PE pair integrity remains enforced;
- student upserts, import/batch/schedule-item creation, appointments, publication, and related writes remain in the existing authoritative transaction boundaries;
- notification behavior remains tied to the authoritative scheduling transaction;
- failures do not leave partially published schedules.

Do not simplify the architecture by splitting currently atomic behavior into independent writes.

## Compatibility Rules

There is intentionally no compatibility translation between configurable priority groups and current category-based priority behavior.

Do not implement mappings such as:

```text
priority_group.rank_order -> category priority
```

Do not create a replacement configurable-priority table, enum, API, or settings UI.

Deleted application/API routes should return ordinary 404 through route absence. No compatibility redirects or 410 responses are required.

## Documentation Changes

Update `README.md` to match the current code and approved scope.

Remove or correct statements that:

- list `SPECIALIZED` as a supported category;
- say Specialized imports require a preferred month;
- describe manual validate/generate/publish checkpoints;
- claim historical manually saved imports retain lifecycle actions;
- present configurable priority groups as current scheduling configuration.

Document the supported scheduling model as Regular, Tour, OJT, and First-Year/OVPSA behavior driven by the current import policy and atomic scheduler.

Add migration `026` to migration documentation as the point where configurable priority groups and the legacy scheduling workflow were retired.

Do not rewrite historical design reports or migrations solely to remove old terminology where doing so would falsify history.

## Test Strategy

### Remove legacy-only tests

Delete tests whose sole purpose is to prove behavior of the retired manual/staged workflow, including cases that directly depend on:

- `addScheduleBatch()`;
- `validateScheduleImport()`;
- `generateScheduleImport()`;
- `publishScheduleImport()`;
- `priorityGroupId`;
- manual batch generation/publication routes.

For mixed files such as `schedule-imports.integration.test.ts`, remove only the legacy cases while retaining current atomic-import coverage.

### Retain and strengthen current behavior tests

Preserve coverage for:

- Regular atomic imports;
- Tour imports;
- OJT imports;
- First-Year/OVPSA imports;
- year/category validation;
- Laboratory-before-PE pairing;
- maximum daily capacity;
- scheduling locks/concurrency;
- protected appointments;
- category-based displacement of eligible Regular appointments;
- rollback on failed scheduling;
- import history/detail reads;
- clinic-calendar and closure behavior that depends on current scheduling provenance.

Do not delete `priority-displacement` tests simply because the configurable `priority_groups` feature is removed.

### New cleanup regression tests

Add focused coverage proving:

1. After migration `026`, `priority_groups` does not exist.
2. After migration `026`, `coordinator_schedule_items.priority_group_id` does not exist.
3. `coordinator_schedule_items` remains usable after migration `026`.
4. A fresh database migrated from `001` through `026` reaches the clean schema successfully.
5. An existing database at `025` upgrades through `026` without deleting valid appointment/import history.
6. A supported atomic schedule import succeeds after migration `026` without any priority-group dependency.
7. Schedule-import detail/history loads without `priorityGroupName`.
8. College/program reference-data behavior still works after priority-group CRUD removal.

Tests do not need to assert a 404 for every deleted route; deleting the route tree is sufficient unless an existing routing test naturally covers it.

## Repository-Wide Dead-Code Gate

Before completion, search active code for these retired symbols/objects:

```text
priority_groups
priority_group_id
priorityGroupId
priorityGroupName
PriorityGroup
listPriorityGroups
"priorityGroup"
validateScheduleImport
generateScheduleImport
publishScheduleImport
addScheduleBatch
generateSchedule
```

There must be no surviving active-code dependency on these names after the cleanup.

Allowed exceptions:

- historical immutable migrations;
- historical design/spec/report documentation where the reference is intentionally descriptive of past architecture.

A broad search for the word `priority` must not be treated as a failure because current category-based displacement and First-Year/OVPSA priority behavior remain valid.

## Deployment Safety

For an existing environment, deploy code and migration as one coordinated cutover:

```text
stop application/workers
        -> deploy new code
        -> npm run db:migrate
        -> verification
        -> start application/workers
```

Never apply migration `026` while an older application version that still queries `priority_groups` is serving traffic.

For the fresh school server, apply migrations `001` through `026` before starting the application for the first time.

## Verification Requirements

At minimum, implementation must run:

```powershell
npm test -- --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000
npm run lint
npm run build
```

Migration verification must also run against a disposable PostgreSQL database for both fresh and upgrade paths.

When the environment supports them, run the current scheduling-related acceptance fixtures that remain relevant, especially:

```powershell
npm run acceptance:first-year-ovpsa:setup
npm run acceptance:first-year-ovpsa:status
npm run acceptance:first-year-ovpsa:cleanup

npm run acceptance:schedule-import-validation:setup
npm run acceptance:schedule-import-validation:status
npm run acceptance:schedule-import-validation:cleanup

npm run acceptance:scheduling-integrity:setup
npm run acceptance:scheduling-integrity:status
npm run acceptance:scheduling-integrity:cleanup
```

If a useful current acceptance fixture still seeds `priority_groups` or requires `priorityGroupId`, update the fixture to use the atomic architecture rather than deleting the fixture.

No implementation may claim tests pass unless those commands were actually executed and their results observed.

## Implementation Boundaries

This cleanup may make targeted refactors required to eliminate legacy dependencies cleanly, but it must not become a general scheduler rewrite.

Out of scope:

- changing Regular/Tour/OJT/First-Year displacement policy;
- changing year/category eligibility rules;
- changing scheduling windows or preparation-boundary rules;
- changing capacity policy;
- changing clinic-closure recovery;
- changing appointment status behavior;
- changing staff or student authentication;
- changing result-upload behavior;
- redesigning the Students/Schedule Imports UI;
- renaming every valid use of `priority`;
- rewriting historical migrations;
- introducing new scheduling categories;
- introducing a new configurable-priority mechanism.

Implementation principle:

> Delete the obsolete architecture; do not redesign the surviving architecture.

## Definition of Done

The cleanup is complete when all of the following are true:

- `priority_groups` is absent from the final database schema.
- `coordinator_schedule_items.priority_group_id` is absent.
- `/api/priority-groups` no longer exists.
- legacy `/api/coordinator-schedules` routes no longer exist.
- retired appointment generate/publish APIs no longer exist.
- staged schedule-import validate/generate/publish APIs and service methods no longer exist.
- the dashboard `/coordinator-schedules` route tree no longer exists.
- legacy generic rank-based scheduler code is removed when no surviving caller needs it.
- `SPECIALIZED` is no longer documented as a supported scheduling category.
- current Regular, Tour, OJT, and First-Year/OVPSA scheduling remains functional.
- category-based displacement remains functional.
- active paired scheduling, capacity, locks, closure recovery, history, reports, and clinic operations remain functional.
- current atomic schedule-import tests and required verification commands pass.
- a developer reading the repository sees one obvious schedule-creation architecture: Schedule Imports -> atomic scheduler.

## Next Step

After this design spec is reviewed and approved, create a separate implementation plan using the Superpowers writing-plans workflow. Do not begin application-code implementation before that plan is prepared.