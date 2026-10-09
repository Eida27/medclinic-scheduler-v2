# PE-linked external Laboratory completion evidence

Implementation of the [approved plan](../plans/2026-10-08-pe-linked-external-laboratory-completion.md) and [design](../specs/2026-10-08-pe-linked-external-laboratory-completion-design.md) on `codex/pe-linked-laboratory`, from `22020b3`. The baseline differs from the plan's `9dba421` only by the design/plan documentation commit.

Local Windows acceptance used Node 24.19, locked dependencies, PostgreSQL 18 and a separately owned loopback database on port 55440. All 32 migrations and reference seeds ran before synthetic setup. No schema, dependency, appointment accounting or capacity change was introduced.

## Executed implementation checks

Each implementation task followed RED/GREEN before its commit. Task 1 passed 25 policy/requirement tests and six checklist integration tests. Task 2 passed nine checklist/finalizer integration tests and three endpoint tests. Task 3 passed 27 selected integration tests and six context/replay tests. Task 4 passed 32 UI/detail/endpoint tests. Task 5 passed 66 integration tests across PE-linked lifecycle, checklist, appointment locking and database invariants.

Browser acceptance found two UI gaps: the published PE list still required a raw Laboratory Completed status, and the read-only detail retained its pre-issuance checklist state. Four list regressions and two server-prop refresh regressions failed before the respective fixes. The final focused UI run passed **40 tests in four files**, including checklist, published list, completion form and dialog.

## Authenticated Browser acceptance, October 8–9, 2026 (Manila)

Four synthetic students, eight existing appointments, complete immutable import/snapshot provenance and an active synthetic physician were prepared through the guarded fixture. First-Year used a real `FIRST_YEAR_OVPSA` publication with owned reservations. The ordinary Laboratory/PE dates were October 7/8; First-Year dates were October 8/15. Both actual examinations were recorded on October 8. Capacity remained 100 per service.

- KABALAKA staff verified OJT CBC, Urine and Stool, leaving four required tests with only X-ray disabled and 3/4 Pending. The initial automatic no-show correction retained its required explanation. Ordinary controls kept their three manual tests.
- CPU staff saw eligible OJT and First-Year list actions. OJT with missing CBC/Urine/Stool displayed the named blockers with preview/submit disabled; the ordinary incomplete Laboratory retained its prerequisite. Paired checklists on PE detail were read-only.
- OJT Class A preview was cancelled. Exact serialized state across 15 clinical/document/audit/notification categories was unchanged (SHA-256 `f48dbff5afb3e4bdfc3b87d60d4cb6cfebe9e1ebfb3fe3072e97d0b17cb938bb`). Submit produced 4/4 and completed both appointments with one certificate.
- First-Year 0/4 Pending was ready for PE. The form required one hospital-specific attestation. A future actual examination date was correctly rejected; October 8 was accepted. A remarked Class B preview was cancelled and all 15 state categories were unchanged (SHA-256 `d92ddea38897db10965097ed0123d9dcb5d559816c91884e655befdb503b1afd`). Submit produced 4/4, both appointments Completed, one external summary/result and one certificate.
- Reload retained checked 4/4 on PE detail and OJT Laboratory detail. The staff First-Year list label changed from **Awaiting confirmation at Physical Examination** to **COMPLETED**.
- Both unverified students signed in, saw both current appointments Completed and read Results. Their own Class A/B JPGs downloaded through the Browser's actual link/download event. Both downloads matched stored certificate SHA-256 and byte length and decoded as 3508×2480 JPEGs. OJT upload management redirected to email verification with the correct appointment-bound return destination; no verification email was sent.
- The resumed student and staff tabs had zero captured console errors. The Browser's initial media-download helper timed out during compilation; the subsequent actual download events succeeded. Interrupted prior test jobs are not passing evidence.

The saved [fixture state](pe-linked-browser-state.json) records two certificates, five external events, one First-Year summary, zero upload drafts/files, two certificate notices, no email outbox work for these unverified students and unchanged capacity. OJT Laboratory document status is `PENDING_UPLOAD`; First-Year external result is `COMPLETED` with the Manila confirmation date October 8. The October 9 startup no-show catch-up affected only the unfinished controls.

The matching guarded cleanup passed: zero synthetic students, appointments, submissions, notifications, staff and physicians; capacity unchanged. Subsequent status returned `prepared: false` and the fixture manifest was removed.

| Student | Downloaded certificate SHA-256 | Bytes |
| --- | --- | --- |
| OJT `99-9331-91` | `90bf90bc0081085ed4970f2ad32d954ecdd9d2a10e64217c251eec0c359d608f` | 540477 |
| First-Year `99-9333-91` | `2fafd52f07060711e2f83db633f8fc47276867164b976d4e8aa270b0ae5e2149` | 577557 |

[OJT 3/4 Pending](pe-linked-ojt-pending-browser.jpg) · [OJT preview](pe-linked-ojt-preview-browser.jpg) · [OJT missing-manual blockers](pe-linked-ojt-blocked-browser.jpg) · [OJT completed](pe-linked-ojt-completed-browser.jpg) · [OJT Laboratory detail](pe-linked-ojt-laboratory-detail-browser.jpg) · [OJT student Results](pe-linked-ojt-student-browser.jpg) · [Downloaded OJT certificate](pe-linked-ojt-student-certificate.jpg)

[First-Year 0/4 Pending](pe-linked-first-year-pending-browser.jpg) · [First-Year preview](pe-linked-first-year-preview-browser.jpg) · [First-Year completed](pe-linked-first-year-completed-browser.jpg) · [First-Year student Results](pe-linked-first-year-student-browser.jpg) · [Downloaded First-Year certificate](pe-linked-first-year-student-certificate.jpg) · [Laboratory list reload](pe-linked-laboratory-list-reload-browser.jpg) · [Console check](pe-linked-browser-console.json)

## Acceptance coverage

| Requirement | Evidence |
| --- | --- |
| A1 missing OJT manual tests | Each missing-code service case; Browser named blockers and disabled preview/submit |
| A2 OJT 3/4 ready → 4/4 completion | Integration persisted events/version/result/snapshot; Browser Class A issuance and reload |
| A3 First-Year 0/4 ready → 4/4 completion | Real OVPSA integration fixture; exact preview state equality; Browser remarked Class B |
| A4 PE-managed check/uncheck | Integration no-op/check/uncheck rejections with unchanged evidence; endpoint 422 contract |
| A5 ordinary categories | Pure required-set policy cases and preserved full Laboratory prerequisite; Browser ordinary control |
| A6 immutable/wrong provenance | Live-year mutation, replacement lineage, missing provenance and wrong current OVPSA revision/batch tests |
| A7 authority/current identity | Coordinator/KABALAKA/deleted/expired/unonboarded rejection; CPU manual CBC rejection |
| A8 failure/preview atomicity | Exact state snapshots for preview, render/final-write failure and invalid classification/date/physician/cycle |
| A9 replay/concurrency | Same-request/different-request barriers; one certificate/summary/version increment and no duplicate notices |
| A10 manual correction/replacement races | Real-render barriers and sorted shared locks; stale issuance rejects without partial effects |
| A11 correction/revocation | Original confirmation metadata/verifier/timestamps/events preserved across correction/preview/revocation |
| A12 midnight sweep | First-Year external exclusion and OJT progress preservation tests; ordinary Browser no-show catch-up |
| A13 documents/verification/ownership | Lifecycle integration result separation; Browser no files/drafts, unverified reading/downloads and upload verification gate; extended student-result tests included in final integration gate |
| A14 classes/history | B/C/D remarks rules, non-Class-A findings and closed-cycle mutation cases; Browser remarked Class B |
| A15 reload/student access | Staff list/detail and student completed schedule/Results; actual matching private JPG downloads |

## Final gates

Pending fresh final execution after the last Browser-driven source fix: `npm test`, `npm run test:integration`, `npm run test:migrations:empty`, `npm run lint`, `npx tsc --noEmit`, `npm run build`. Earlier interrupted jobs and the stale generated `.next/dev/types/validator.ts` typecheck failure do not establish a pass. The owned acceptance server is stopped before archiving only its generated development cache and rerunning TypeScript/build.

## Review and decisions

The fresh whole-branch review follows the final gates. Decisions already made:

1. Keep imported First-Year Laboratory booking under KABALAKA while authorizing CPU external confirmation separately. Tests retain immutable booking and current staff scope. Cost if wrong: valid external checklists could be inaccessible or clinic authority could broaden.
2. Extend the omitted PE list file so authorized Pending/No-show rows open the existing server-context dialog. The dialog supplies policy and blockers without duplicating eligibility. Cost if wrong: a blocked case could open an explanatory form, or an eligible case could lose the list action.

This is local implementation/acceptance evidence. Hosted/Linux execution and SMTP delivery are outside this run. No deployment, merge or publication is implied.
