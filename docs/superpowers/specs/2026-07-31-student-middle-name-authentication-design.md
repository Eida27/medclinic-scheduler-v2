# Student Middle-Name Authentication Design

**Date:** 2026-07-31  
**Repository:** `Eida27/medclinic-scheduler-v2`

## Context

The student portal currently authenticates students using only their Student Number and Date of Birth. The panel requires the student's complete Middle Name to become a third authentication credential. The student sign-in page must also explain that students use the portal to view appointments and upload laboratory and physical examination results.

The CSV importer currently permits a blank Middle Name. That is incompatible with middle-name authentication, so new imports must require a complete middle name for every student.

## Goals

- Require Student Number, Date of Birth, and complete Middle Name during student sign-in.
- Compare the Middle Name without regard to capitalization, while preserving all spacing and punctuation.
- Require the entire stored middle name, including multiple middle-name parts.
- Reject CSV rows whose Middle Name is blank or whitespace-only.
- Preserve the existing generic authentication failure, rate limiting, and student session behavior.
- Replace the sign-in page description with the approved upload-focused text.

## Non-goals

- Do not accept middle initials as a substitute for a complete middle name.
- Do not accept only one part of a multi-part middle name.
- Do not collapse, trim, or otherwise normalize spaces in a submitted authentication value.
- Do not add the middle name to the student session token.
- Do not introduce a new normalized-middle-name database column or database migration.
- Do not change the existing Student Number normalization behavior.

## Approved user interface

The student sign-in form will display these controls in order:

1. Student Number
2. Date of Birth
3. Middle Name
4. Student sign in button

The Middle Name control will be a required plain-text input. It will not be a password input because students must be able to verify spelling, punctuation, and spacing before submission.

The description below the `Student sign in` heading will be:

> Sign in to view your appointments and upload your laboratory and physical examination results.

The existing pending state remains unchanged: while the request is processing, the submit button is disabled and displays `Signing in...`.

## Request and validation flow

The browser will submit this JSON payload to the existing student login endpoint:

```json
{
  "studentNumber": "23-1212-97",
  "dateOfBirth": "2004-08-04",
  "middleName": "Maria Angela"
}
```

The login route and authentication service will require all three values.

Middle Name input validation must reject an absent, empty, or whitespace-only value without transforming the submitted value. Leading spaces, trailing spaces, repeated internal spaces, punctuation, and all other characters must remain available for the credential comparison.

## Middle-name matching rule

Authentication will continue retrieving the student by normalized Student Number. The service will then verify that the student is active and that both the Date of Birth and Middle Name match.

Middle-name comparison will be case-insensitive only:

- Convert the submitted and stored values to the same letter case for comparison.
- Do not trim either value during authentication.
- Do not collapse repeated spaces.
- Do not remove punctuation.
- Do not reduce names to initials.
- Require the full stored value, including every middle-name part.

Examples for a stored value of `De la Cruz`:

| Submitted value | Result | Reason |
|---|---|---|
| `DE LA CRUZ` | Accepted | Capitalization is ignored. |
| `de la cruz` | Accepted | Capitalization is ignored. |
| `Dela Cruz` | Rejected | A stored space is missing. |
| `De  la Cruz` | Rejected | An extra internal space is present. |
| ` De la Cruz` | Rejected | A leading space is present. |
| `De la Cruz ` | Rejected | A trailing space is present. |
| `De la Cruz.` | Rejected | Punctuation differs. |
| `D. L. C.` | Rejected | Initials do not equal the complete name. |

If a legacy student record has no stored middle name, authentication must fail until the record is corrected.

## CSV import rule

The existing exact nine-column CSV structure remains unchanged, including the `Middle Name` header. The Middle Name cell becomes mandatory.

A blank or whitespace-only Middle Name will produce a row-specific validation error:

> Middle Name is required.

The importer already trims the outer whitespace of CSV cells. Therefore, leading and trailing spaces in the source CSV are removed before storage, while internal spaces remain as entered. This import behavior is separate from authentication input matching, where no trimming is permitted.

The downloadable CSV template and test fixtures must contain a complete example middle name.

## Error handling and security

All credential mismatches will use one generic authentication error:

> Invalid Student Number, Date of Birth, or Middle Name.

The response must not reveal which credential was wrong or whether the student exists.

An incorrect Middle Name counts as a failed sign-in attempt. The current lockout remains unchanged:

- Attempts are tracked for the normalized Student Number and IP-address pair.
- Five failed attempts trigger a 15-minute lockout.
- A successful sign-in clears the existing attempt record.

A successful sign-in creates the same student session currently used by the portal. The session continues to contain only the Student Number and session type.

## Components and affected areas

Expected implementation areas include:

- `src/components/student/StudentLoginForm.tsx`
  - Add the required Middle Name input.
  - Include `middleName` in the request body.
- `src/app/(student)/student/login/page.tsx`
  - Replace the description with the approved text.
- `src/app/api/student-auth/login/route.ts`
  - Require and preserve the submitted Middle Name.
- `src/server/services/student-auth.service.ts`
  - Accept Middle Name and apply the approved comparison rule.
  - Update the generic credential error.
- `src/server/repositories/student-auth.repository.ts`
  - Return the student's stored Middle Name with the existing credential record.
- `src/server/services/student-import-csv.ts`
  - Reject blank or whitespace-only Middle Name values.
- `public/templates/student-schedule-import-template.csv`
  - Keep a complete Middle Name in the example row.
- Existing unit, integration, route, and component tests related to CSV import and student authentication.

## Test coverage

Tests will verify:

1. The form renders a required Middle Name field.
2. The form submits Student Number, Date of Birth, and Middle Name.
3. The approved sign-in description is rendered.
4. Correct complete Middle Name authenticates successfully.
5. Different capitalization authenticates successfully.
6. Missing internal spaces are rejected.
7. Extra internal spaces are rejected.
8. Leading and trailing spaces are rejected.
9. Different punctuation is rejected.
10. A middle initial is rejected when a complete middle name is stored.
11. Any missing credential is rejected before authentication.
12. Legacy records without a stored middle name cannot authenticate.
13. Blank or whitespace-only CSV Middle Name cells are rejected with a row-specific error.
14. Existing CSV limits, header validation, encoding support, and duplicate Student Number checks still work.
15. Incorrect middle names increment the existing login-attempt counter.
16. Five failed attempts still trigger the 15-minute lockout.
17. Successful sign-in still creates the existing minimal student session.
18. Authentication failures use the new generic message without identifying the incorrect field.

## Acceptance criteria

The feature is complete when:

- Students cannot submit the sign-in form without all three credentials.
- Authentication succeeds only when Student Number, Date of Birth, and complete Middle Name all match under the approved case-insensitive-only rule.
- Any spacing or punctuation difference in Middle Name causes authentication to fail.
- CSV imports reject every row without a complete Middle Name.
- Existing students without a Middle Name cannot sign in until their records are corrected.
- The page displays the approved description.
- Existing rate limiting and session behavior remain intact.
- All affected automated tests pass.
