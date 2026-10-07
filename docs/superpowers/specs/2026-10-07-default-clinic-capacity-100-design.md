# Default Clinic Daily Capacity of 100 — Implementation Design Spec

**Date:** 2026-10-07  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Reviewed branch and commit:** `main` at `62b780bcb5cb7f9adb6176b4dcd4dd579cb6c62c`  
**Status:** Ready for Codex implementation. This document commit does not change application behavior.  
**Implementation plan:** [Default clinic capacity implementation plan](../plans/2026-10-07-default-clinic-capacity-100.md)

## 1. Intended outcome

On the first deployment to a completely fresh database, initialize the maximum daily capacity to **100 students per clinic service**, replacing the current default of 150.

| Clinic code | Clinic | Service | Current seeded maximum/day | New seeded maximum/day |
| --- | --- | --- | ---: | ---: |
| `KABALAKA_CLINIC` | KABALAKA Clinic | `LABORATORY` | 150 | 100 |
| `CPU_CLINIC` | CPU Clinic | `PHYSICAL_EXAM` | 150 | 100 |

These are separate service limits, shared by all eligible student categories using that service on that date. They are not a combined campus limit, a limit per import, or a limit per college.

“Default maximum” means the initial configured value. Administrators retain the existing ability to save another positive integer, including values above 100, through Daily capacity settings. The effective configured value remains the ceiling enforced by scheduling and replacement workflows.

The user requested planning documents committed to GitHub for later Codex implementation. Product changes, database execution and deployment are outside this documentation commit.

## 2. Repository findings

The reviewed source has these relevant contracts:

| File | Observed behavior and implication |
| --- | --- |
| `database/seeds/001_reference_and_users.sql` | Explicitly inserts both canonical capacity rows with `max_daily_capacity=150`; `ON CONFLICT (id) DO NOTHING` preserves existing rows. |
| `database/migrations/002_users_and_reference_data.sql` | Originally defines a database maximum default of 150 and a legacy safe default of 120 with a maximum-versus-safe comparison constraint. |
| `database/migrations/030_remove_safe_daily_capacity.sql` | Removes the safe column/comparison constraint and adds `clinic_capacity_settings_max_daily_capacity_positive`. It leaves the maximum column default at 150. |
| `database/migrations/031_retire_manual_schedule_metadata.sql` | Last migration at this baseline. The next unused number is 032. |
| `src/server/repositories/appointments.repository.ts` | Settings reads and updates use stored maximums. Reductions conflicting with committed current/future internal workload return a conflict. |
| `src/server/services/appointments.service.ts` | `changeCapacity(raw, actorUserId)` validates a positive integer, serializes on the scheduling queue and updates/audits transactionally. |
| `src/components/settings/CapacityForm.tsx` | Displays supplied `maxDailyCapacity` values; it has no independent 150 default. |
| `src/server/repositories/schedule-imports.repository.ts` | Loads both service capacities and passes them to paired scheduling. |
| `src/server/ovpsa/ovpsa-first-year.repository.ts` | Loads the stored CPU Physical Examination maximum for First-Year/OVPSA allocation. |
| `src/server/services/calendar-occupancy.service.ts` | Reads stored capacities; either full service makes a day red. Empty, unconfigured and external-service cases have distinct existing behavior. |
| `src/lib/env.ts` and `.env.example` | Current capacity configuration has no `MAX_*_DAILY_CAPACITY` environment setting. Do not restore obsolete environment configuration. |
| `scripts/browser-scheduling-integrity-fixture.ts` | Assumes a full CPU day is 150 students and refuses setup unless the stored maximum equals that count. |
| `src/server/db/priority-groups-retirement-migration.integration.test.ts` | Executes the current seed against isolated pre-030 schemas. A new maximum of 100 would conflict with the historical safe default of 120. |

The distinction between the SQL default and explicit seeded values matters: changing only the seed would leave omitted-column inserts defaulting to 150.

## 3. Selected approach

| Approach | Assessment |
| --- | --- |
| Change both seed values and add a forward migration setting the SQL default to 100 after 030 | **Selected.** Aligns first-install values and final-schema inserts, preserves migration history and avoids the retired safe constraint. |
| Change only the seed | Incomplete: the final SQL default would remain 150. |
| Rewrite migration 002 and adjust its historical safe-capacity definition | Unnecessary historical schema changes and additional migration-isolation consequences for a bounded default change. |

Create `database/migrations/032_default_clinic_capacity_100.sql` with:

```sql
ALTER TABLE clinic_capacity_settings
  ALTER COLUMN max_daily_capacity SET DEFAULT 100;
```

Use the existing migration runner's transaction; do not put transaction-control statements in the migration. Preserve migrations 001–031 unchanged.

Change only the two capacity values in the production seed to 100. Preserve their IDs, clinic/service mapping, active defaults, conflict behavior, reference catalog and absence of production demo users/students.

Migration 032 changes the column default only. It does not update existing capacity rows, move appointments or enqueue notifications. On a fresh installation, migrations run before the reference seed, so both canonical rows start at 100. Repeating the seed must preserve an Administrator's saved value.

If 032 is occupied when implementation begins, choose the next unused migration number and update this spec, plan, rehearsal assertions and current documentation together.

## 4. Required behavior

### 4.1 Persistence and settings

After migrate → seed on an empty database, the settings repository/API and Administrator Daily capacity page must show 100 for both canonical services.

An insert into the final schema that omits `max_daily_capacity` must receive 100. Maximums remain non-null positive integers, with the existing named positivity constraint and clinic/service uniqueness. The retired safe-capacity column must remain absent.

Administrators may independently change either service to another valid maximum. Existing authentication, authorization, validation, queue locking, conflict detection and atomic audit behavior remain authoritative. Refreshing settings must show the saved value. Neither a page refresh nor rerunning the seed may reset it to 100.

Do not add a new constant, environment fallback, UI-only default or API interface solely for this change. Missing capacity configuration must keep its existing explicit failure behavior.

### 4.2 Scheduling and calendar

All imports, displacement, closures, single/bulk replacements and Manual Resolution must continue to consume the stored maximum. Preserve FCFS/category policy, weekdays, preparation boundaries, configured academic-cycle bounds, Laboratory-before-PE ordering, protections and atomic publication.

For an isolated Standard import with 101 eligible students and no competing loads/blocks, each internal service allocates 100 on its first eligible date and the remaining student on its next eligible date. Each student's Laboratory date remains before their PE date. Existing load participates in the same limit: 99 committed slots leave one slot; a full 100-slot date cannot accept another internal appointment.

At the default maximum, 99 used internal slots are available/green and 100 are full/red for either service. The calendar continues to distinguish empty dates, missing settings, external Laboratory activity and reservation holds. Preserve existing occupancy predicates rather than introducing a second counting rule.

First-Year/OVPSA PE allocation uses the CPU maximum of 100. For 280 students with no conflicts or blocks, the PE allocations are 100, 100 and 80 in CSV order across eligible dates. Preserve its fixed authoritative Laboratory date, external Laboratory accounting, owned reservations and minimum seven-calendar-day PE gap. An external Laboratory cohort must not be rejected or split merely because it contains more than 100 students.

### 4.3 Test and acceptance fixtures

Update the scheduling-integrity acceptance fixture's `CAPACITY_STUDENT_COUNT` to 100. Preserve its deterministic full-day guard and owned setup/status/cleanup contracts. Update matching unit/integration expectations: 100 capacity students, 100 capacity appointments and 104 academic snapshots.

Separate historical migration fixtures from the current production seed's capacity block. In the migration-026 test, keep the production college/program/clinic reference statements, but insert explicit test-only historical capacity rows with valid safe/maximum values of 150/150 in the disposable pre-030 schema. Preserve both its fresh-026 and upgrade-from-025 scenarios. Do not add a production legacy compatibility writer or change historical migrations to make a test pass.

Retain intentional nondefault fixtures. The First-Year browser fixture explicitly saves PE capacity 150 and restores its prior value; its 150/130 allocations still test that configured value. Capacity-integrity tests explicitly start at 150 to exercise reductions. Pagination limits of 150, text lengths, dates, colors and identifiers are unrelated.

### 4.4 Current documentation

During product implementation, update `README.md`, `database/README.md`, `docs/installation.md`, `docs/e2e.md` and `docs/current-policies.md` to describe both defaults as 100 and the completed migration chain as 32 migrations through 032, with zero on replay.

Add this spec/plan to the capacity authority entry in the policy index. Supersede only earlier default-150 guidance; explicit custom-capacity examples and unrelated historical requirements remain valid. Preserve historical plans and evidence as records of their original baseline.

Explain that changing the default does not retroactively change previously seeded developer databases. Do not make reset, reseed-overwrite or blanket data updates part of first installation.

## 5. Global constraints

- Fresh first deployment; no production data migration or appointment rewrite.
- Default maximum: 100 students per day for KABALAKA Laboratory and 100 for CPU Physical Examination.
- Administrator-configured positive integer maximums remain supported, including values above 100.
- Preserve migrations 001–031; append the next unused migration after 031.
- Maximum-only capacity; do not restore safe capacity or capacity environment settings.
- Preserve existing scheduling, service accounting, authorization, audit and fixture ownership contracts.
- No dependency upgrades, new infrastructure or unrelated refactoring.

## 6. Acceptance criteria

| ID | Evidence required |
| --- | --- |
| AC1 | Fresh production migration CLI applies 32 files through `032_default_clinic_capacity_100.sql`; replay applies 0 and the exact ledger, rollback and cleanup checks pass. |
| AC2 | Fresh production reference seed creates exactly the two canonical service capacity rows at 100, with zero seeded staff users or students. |
| AC3 | A final-schema omitted-maximum insert returns 100; nonpositive/null values remain rejected and safe capacity remains absent. |
| AC4 | Independent saved maximums such as 80 and 120 survive reread and seed replay; settings display supplied values and existing mutation protections pass. |
| AC5 | The 101-student Standard import produces 100/1 internal daily loads for both services, 202 published appointments and 101 correctly ordered complete pairs. |
| AC6 | First-Year/OVPSA review/publication for 280 students produces PE 100/100/80, preserves CSV order and the fixed external Laboratory date, and remains atomic. |
| AC7 | Either service at 99/100 is green/red respectively; existing empty/missing/external/reservation behavior remains intact. |
| AC8 | Scheduling-integrity setup/status/cleanup succeeds with 100 full-day students and 104 snapshots; historical-026 and explicit-150 fixture scenarios still pass and restore baselines. |
| AC9 | Current setup/policy documents agree with the implemented defaults and migration count; no runtime hard-coded 100 ceiling or global replacement of 150 is introduced. |

## 7. Implementation handoff

Follow the linked plan in order. Run behavior checks against owned disposable PostgreSQL targets; do not execute migrations or resets against an ordinary development/application database during verification.

This proposal changes initial capacity configuration. It does not authorize importing real student/medical data, rescheduling existing students or deploying the application.
