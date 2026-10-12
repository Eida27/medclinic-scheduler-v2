# Fourth-Year OJT X-ray notification implementation evidence

Date: 2026-10-12 (Asia/Manila). Status: implementation, authenticated Browser acceptance, full regression gates and independent whole-branch review passed.

Baseline: clean local `main` at `e0c6ee98474df4ca26087c609d087a66ffe80ada`. Implementation branch: `codex/ojt-xray-notifications`, in the Codex-managed `ojt-xray-notifications` worktree. The plan's `957310b` reference is its historical review baseline.

Authority: [design](../specs/2026-10-11-fourth-year-ojt-xray-notifications-design.md) and [implementation plan](../plans/2026-10-11-fourth-year-ojt-xray-notifications.md).

## Implementation and test-first proof

- Resolver: missing-module RED, then 32 passing cases for saved eligibility, status, invalid dates, calendar boundaries and clock/timezone independence.
- Repository: one missing-detail assertion RED (seven existing/negative assertions passed), then eight passing cases. Linked saved cohort eligibility survives live profile changes and Laboratory replacement; PE replacement leaves the anchor unchanged. Missing context retains general schedules.
- Composition: 12 new assertions RED with 12 existing assertions passing, then 36 passing tests across builders, enqueue isolation and unverified notification routes/pages. All nine shared builders use the common detail; the literal non-OJT hash remains unchanged.
- Lifecycle/component: corrected fixture cleanup order and after-today destination handling, then 17 focused integration tests and the own-notice component test passed. The final full run executed all 14 OJT lifecycle cases, including SMTP outage and an exact past external date, plus the four bulk replacement cases.
- Clinical policy, migrations, dependency versions, endpoint types and appointment services are unchanged.

## Commands and gates

All integration commands use the existing owned disposable runner with fresh `medclinic_test_ojt_*` targets on a dedicated PostgreSQL instance bound to `127.0.0.1:55483`. Each runner verifies database identity and drops its owned target. The application database is not reset, migrated or used for fixtures.

| Check | Observed result |
| --- | --- |
| `npm.cmd ci --no-audit --no-fund` | Exit 0; current lockfile |
| Resolver unit tests | Exit 0; 32 passed |
| Schedule-state repository integration | Exit 0; 8 passed |
| Builders / notification service / notification route / notification page | Exit 0; 36 passed |
| `NotificationList.test.tsx` | Exit 0; 1 passed |
| OJT lifecycle and bulk replacement focused integration | Exit 0; 18 passed on the final task-completion run (the earlier run had 17 before the outage case) |
| Full unit suite, final low-load run | Exit 0; 220 files and 1,321 tests passed, no skipped tests; 1,602.95 seconds |
| Full integration suite, final low-load run | Exit 0; 75 files and 650 tests passed, no skipped tests; 770.60 seconds; storage/database residue zero |
| Full integration suite, first attempt | Exit 1; 595 passed, 40 failed, 15 skipped, across 75 files. Early rendering/fixture timeouts cascaded into fixture ownership/constraint failures during memory pressure; all 650 executed and passed in the fresh low-load run |
| Empty database migration CLI proof | Exit 0; 32 applied, exact ledger/schema assertions, zero applied on rerun, atomic rollback/connection proof and zero database residue |
| `next typegen` / `tsc --noEmit` | Exit 0 |
| `npm.cmd run lint` | Exit 0 |
| Production `next build` with synthetic configuration | Exit 0 on retry; first attempt failed to fetch four existing Google font files. Direct font request returned HTTP 200 before retry; no font/source change |

The host has 8 GB RAM. Overlapping full verification runs reduced free memory to 0.33 GB; the redundant unchanged-main baseline and the four-worker unit attempt were interrupted and are not counted as passes. A subsequent unit attempt had five calendar timeouts (1,316 passed). The unchanged calendar file passed all nine cases in isolation with identical deadlines, and all 1,321 unit cases then passed without competing heavy checks. The full integration command ran only after unit completion. The late-date integration proof owns only its 2092 academic year and controls Date alone, avoiding interference with another suite's current-year fixture. No timeout threshold or existing calendar/clinical implementation was changed.

Final suite commands: `npm.cmd test -- --maxWorkers=1 --no-file-parallelism --testTimeout=15000 --hookTimeout=30000 --reporter=verbose`, followed by `npm.cmd run test:integration -- --testTimeout=15000 --hookTimeout=30000 --reporter=verbose`. The integration wrapper supplies a fresh owned loopback target. Migration proof used `npm.cmd run test:migrations:empty`; type/build checks used the local Next CLI with synthetic configuration. Logs are retained during implementation in the ignored plan workspace; this record carries the final counts and outcomes.

## Authenticated Browser acceptance

Browser used the actual production build at `http://127.0.0.1:4318`, with a newly owned disposable database and private upload root. Staff bootstrap, real email confirmation and temporary-password replacement ran through application services and the loopback SMTP sink. Credentials and tokens stayed in the ignored local manifest. OJT and First-Year publication used the actual nine-column import service. Scheduling changes used the real replacement and Manual Resolution services.

| Flow | Stored/current result | Evidence |
| --- | --- | --- |
| OJT publication before any login/verification | Laboratory 2092-11-03; X-ray 2092-10-27; notice already stored | [pre-login data](2026-10-11-fourth-year-ojt-xray-notifications/publication-before-login-data.json), [desktop](2026-10-11-fourth-year-ojt-xray-notifications/publication-desktop.jpg) |
| Unverified reading and own mark-read | 0 unread after marking the publication; accessible at 390 × 844 | [mobile](2026-10-11-fourth-year-ojt-xray-notifications/publication-mobile-read.jpg) |
| Laboratory replacement | Effective Laboratory 2092-10-27; X-ray 2092-10-20; original read state preserved | [data](2026-10-11-fourth-year-ojt-xray-notifications/laboratory-replacement-data.json), [mobile mark-read](2026-10-11-fourth-year-ojt-xray-notifications/laboratory-replacement-mobile-read.jpg) |
| PE-only replacement | PE 2092-11-11; Laboratory/X-ray remain 2092-10-27 / 2092-10-20 | [data](2026-10-11-fourth-year-ojt-xray-notifications/pe-replacement-data.json), [desktop](2026-10-11-fourth-year-ojt-xray-notifications/pe-replacement-desktop.jpg) |
| Awaiting Manual Resolution | Both external dates null; newest notice says awaiting an authorized KABALAKA date. Older notices remain historical | [data](2026-10-11-fourth-year-ojt-xray-notifications/awaiting-resolution-data.json), [desktop](2026-10-11-fourth-year-ojt-xray-notifications/awaiting-resolution-desktop.jpg) |
| Manual Resolution completed | New Laboratory 2092-10-20; X-ray 2092-10-13 | [data](2026-10-11-fourth-year-ojt-xray-notifications/resolution-completed-data.json), [desktop](2026-10-11-fourth-year-ojt-xray-notifications/resolution-completed-desktop.jpg) |
| First verification and SMTP delivery | One current-state schedule email; exact portal/email X-ray line matches 2092-10-13 / 2092-10-20 | [SMTP/content proof](2026-10-11-fourth-year-ojt-xray-notifications/verified-email-proof.json), [portal](2026-10-11-fourth-year-ojt-xray-notifications/verified-current-state-desktop.jpg) |
| Saved fourth-year Regular/Tour | No OJT X-ray instruction | [Regular](2026-10-11-fourth-year-ojt-xray-notifications/fourth-year-regular-desktop.jpg), [Tour](2026-10-11-fourth-year-ojt-xray-notifications/fourth-year-tour-desktop.jpg) |
| First-Year/OVPSA | Existing external Laboratory and PE dates; no OJT minus-seven instruction | [desktop](2026-10-11-fourth-year-ojt-xray-notifications/first-year-ovpsa-desktop.jpg) |

The current import policy accepts Year 4 only as OJT. Fourth-year Regular/Tour comparisons therefore use valid saved snapshot/checklist fixtures and the shared publication hook, preserving that import policy. Existing category rejection tests remain part of the regressions.

Each read phase compared the complete appointment/checklist/capacity snapshot before and after Browser reading/mark-read. [Final proof](2026-10-11-fourth-year-ojt-xray-notifications/browser-final-proof.json): unchanged clinical state; zero verified checklist items, results, submissions, files and certificates; only Laboratory/PE service rows; 11 total rows after the three authorized internal replacements; the two existing First-Year service reservations remain. Both clinic capacities remain 100. [Browser warning/error log](2026-10-11-fourth-year-ojt-xray-notifications/browser-console.json) is empty.

Browser viewport override was reset and its temporary tab closed. The owned app/SMTP/control server were stopped. The disposable acceptance runner reported its database dropped with residue zero.

## Execution decisions

- Began per-task work after the passing focused baseline while the unchanged-main full baseline ran; unrelated baseline failures could have been discovered later. Final full unit and integration regressions subsequently passed.
- Used saved fourth-year Regular/Tour fixtures because current import policy prohibits importing those combinations. If that policy changes, fresh import-path coverage is required.

## Final review

An independent fresh-context reviewer inspected `e0c6ee9..cfb0d93`, the binding spec/plan, ledger rulings, implementation/tests, surrounding publication/replacement/delivery code and acceptance evidence. All five review-focus areas were assessed. Critical: none. Important: none. Minor: none. Declined to judge: none. Assessment: ready to merge; no code changes required.

Typecheck and lint were reconfirmed after the final integration-test adjustment and documentation updates, both exit 0. The final focused task-completion command passed all 18 lifecycle/bulk cases and disposed its target with zero residue. The implementation worktree is retained for the user's integration choice; ordinary application data and `main` are preserved.

Final cleanup verified zero remaining owned databases before stopping the dedicated PostgreSQL cluster. Ports 55483, 4318 and 4320 have no listener. The private acceptance manifest/logs, private cluster directory and this plan's ignored scratch workspace were removed; committed evidence remains available.
