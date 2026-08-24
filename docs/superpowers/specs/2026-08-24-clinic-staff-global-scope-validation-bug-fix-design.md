# Clinic Staff Global Scope Validation Bug Fix – Implementation Design Spec

Date: 2026-08-24
Repository: `Eida27/medclinic-scheduler-v2`
Target branch: `main`
Reviewed commit: `5720cd518e42364d1917c9e4914a3ceab4dbeef5`
Status: Approved implementation design

## 1. Purpose

Fix the **Clinic users** administration form where an administrator can currently select:

```text
Role: Clinic staff
Clinic: Global
```

even though the backend does not allow a clinic staff account without a specific clinic assignment.

After implementation:

- `CLINIC_STAFF` must be assigned to either:
  - `KABALAKA_CLINIC`, or
  - `CPU_CLINIC`.
- `COORDINATOR` accounts remain global.
- `ADMIN` accounts remain global.
- `Global` must not be selectable while the selected role is `CLINIC_STAFF`.
- Existing backend validation must remain in place as a security and data-integrity safeguard.
- Validation errors returned by the API should display a useful field-specific message when available instead of only the generic `Please correct the highlighted fields.`

## 2. Current Problem

The current user creation UI allows clinic staff to select all three clinic values:

```text
KABALAKA Clinic
CPU Clinic
Global
```

The frontend therefore allows this combination:

```text
CLINIC_STAFF + Global
```

When submitted, `Global` is represented by an empty `clinicCode`.

The backend schema transforms the empty value to `null` and rejects the request because clinic staff are required to have a clinic assignment.

The server correctly generates the validation issue:

```text
Clinic staff must be assigned to a clinic.
```

However, the frontend currently reads only the top-level API error message:

```text
Please correct the highlighted fields.
```

and ignores the field-level validation details.

This produces two related UX problems:

1. The form presents an invalid option to the administrator.
2. When the invalid combination is submitted, the administrator receives a generic error instead of the actual reason.

## 3. Root Cause

The problem is a frontend/backend contract mismatch.

### Frontend behavior

`src/components/settings/UsersManager.tsx`

The Clinic dropdown always contains:

```text
KABALAKA_CLINIC
CPU_CLINIC
Global
```

for clinic staff.

### Backend behavior

`src/server/services/users.service.ts`

The backend already requires:

```text
CLINIC_STAFF -> clinicCode is required
COORDINATOR  -> clinicCode must be null/global
```

Therefore the backend is behaving correctly.

The primary fix belongs in the frontend.

The server-side validation must not be weakened or removed.

## 4. Required Role and Clinic Matrix

The user-management form must enforce the following combinations:

| Role | Allowed clinic scope |
|---|---|
| Administrator | Global |
| Coordinator | Global |
| Clinic staff | KABALAKA Clinic |
| Clinic staff | CPU Clinic |

The following state must not be selectable:

```text
Clinic staff + Global
```

## 5. UI Behavior

### 5.1 Clinic Staff

When the selected role is `Clinic staff`, the Clinic field must:

- remain enabled;
- default to `KABALAKA_CLINIC`;
- offer `KABALAKA Clinic`;
- offer `CPU Clinic`;
- not offer `Global`.

Expected dropdown:

```text
Clinic
├── KABALAKA Clinic
└── CPU Clinic
```

### 5.2 Coordinator

When the selected role changes to `Coordinator`, the Clinic field must:

- automatically change to `Global`;
- become disabled/read-only;
- visually display `Global`;
- submit an empty `clinicCode` so the backend converts it to `null`.

Expected state:

```text
Role:   Coordinator
Clinic: Global [disabled]
```

The existing coordinator behavior must remain intact.

### 5.3 Administrator

When the selected role changes to `Administrator`, the same global behavior must apply:

```text
Role:   Administrator
Clinic: Global [disabled]
```

Administrators must not be assigned directly to either individual clinic through this form.

### 5.4 Switching Back to Clinic Staff

If the administrator changes:

```text
Coordinator/Admin
        ↓
Clinic staff
```

the Clinic field must:

1. become enabled again;
2. stop using the global empty value;
3. reset to a valid clinic.

Use the existing default:

```text
KABALAKA_CLINIC
```

This prevents an invisible or stale global value from being submitted for clinic staff.

## 6. Frontend Implementation

Modify:

```text
src/components/settings/UsersManager.tsx
```

### 6.1 Role State

Preserve the existing determination that these roles are global:

```text
ADMIN
COORDINATOR
```

`CLINIC_STAFF` must continue to be treated as a clinic-specific role.

### 6.2 Clinic Options

Do not render the `Global` option for `CLINIC_STAFF`.

Conceptually:

```text
is global role?
    yes -> render only Global
    no  -> render KABALAKA Clinic + CPU Clinic
```

This is preferred over leaving `Global` visible but disabling it because the invalid combination should not appear to be a supported clinic-staff option.

### 6.3 Hidden Clinic Value

For global roles, preserve the hidden form value:

```text
clinicCode=""
```

because disabled HTML fields are not included in `FormData`.

The hidden input ensures Administrator and Coordinator submissions still contain the expected global clinic value.

Clinic staff must not receive this hidden global value.

## 7. API Validation Error Handling

The existing API response format for Zod validation includes both:

```text
error.message
error.fields
```

For example:

```text
error.message:
Please correct the highlighted fields.

error.fields.clinicCode:
Clinic staff must be assigned to a clinic.
```

Update `UsersManager.tsx` so the form uses a field-specific validation message when available.

Recommended priority:

```text
1. clinicCode field error
2. fullName/email/password/role field error if applicable
3. top-level error.message fallback
4. generic fallback only if no useful message exists
```

For this bug, an invalid clinic assignment reaching the API should therefore show:

```text
Clinic staff must be assigned to a clinic.
```

instead of only:

```text
Please correct the highlighted fields.
```

This is defensive UX. The corrected dropdown should normally prevent this error from occurring through normal interaction.

## 8. Backend Contract

Do not remove or weaken the current validation in:

```text
src/server/services/users.service.ts
```

The backend must continue rejecting:

```text
CLINIC_STAFF + null clinicCode
CLINIC_STAFF + empty clinicCode
```

The backend remains authoritative even though the frontend prevents the invalid state.

This protects against:

- manually crafted API requests;
- future frontend regressions;
- direct requests to `/api/users`;
- malformed clients;
- accidental programmatic submissions.

The rule:

```text
Clinic staff must be assigned to a clinic.
```

must remain.

## 9. No Database Changes

This fix does not require:

- schema changes;
- migrations;
- seed changes;
- clinic table modifications;
- role changes;
- session changes;
- authentication changes.

The database already supports the intended model.

## 10. Existing User Records

This change affects creation/editing behavior only.

Existing valid users such as:

```text
Clinic staff + KABALAKA Clinic
Clinic staff + CPU Clinic
Coordinator + Global
Administrator + Global
```

must continue to display normally.

No migration of existing users is required.

If an invalid legacy `CLINIC_STAFF` account with no clinic assignment somehow exists in the database, this feature should not automatically assign that account to a clinic. That should be handled separately because silently choosing a clinic could grant incorrect access.

## 11. Testing Strategy

Modify:

```text
src/components/settings/UsersManager.test.tsx
```

Use the existing React Testing Library and Vitest patterns.

### 11.1 Clinic Staff Does Not See Global

Render the form in its default `CLINIC_STAFF` state.

Verify:

```text
Clinic dropdown is enabled
KABALAKA Clinic is available
CPU Clinic is available
Global is not available
Default value = KABALAKA_CLINIC
```

### 11.2 Clinic Staff Can Select CPU Clinic

Select `CPU Clinic`, submit the form, and verify the request contains:

```json
{
  "role": "CLINIC_STAFF",
  "clinicCode": "CPU_CLINIC"
}
```

### 11.3 Clinic Staff Can Select KABALAKA Clinic

Submit with the default clinic and verify:

```json
{
  "role": "CLINIC_STAFF",
  "clinicCode": "KABALAKA_CLINIC"
}
```

### 11.4 Coordinator Remains Global

Preserve the existing coordinator regression test.

Verify:

```text
Role = COORDINATOR
Clinic dropdown = disabled
Clinic displayed = Global
Submitted clinicCode = ""
```

### 11.5 Administrator Is Global

Add equivalent coverage for `ADMIN`.

Verify:

```text
Clinic dropdown is disabled
Clinic displays Global
Submitted clinicCode = ""
```

### 11.6 Global Role → Clinic Staff

Test:

```text
CLINIC_STAFF
→ COORDINATOR
→ CLINIC_STAFF
```

Verify after switching back:

```text
Clinic dropdown is enabled
Value = KABALAKA_CLINIC
Global is not available
```

Repeat through `ADMIN` if useful.

This protects against stale empty clinic state.

### 11.7 Field-Specific API Error

Mock `/api/users` returning:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please correct the highlighted fields.",
    "fields": {
      "clinicCode": [
        "Clinic staff must be assigned to a clinic."
      ]
    }
  }
}
```

Verify that the page displays:

```text
Clinic staff must be assigned to a clinic.
```

and does not rely solely on the generic validation message.

## 12. Server Regression Protection

The existing server validation remains unchanged.

If additional focused coverage is desirable, add a small schema regression test proving:

```text
CLINIC_STAFF + KABALAKA_CLINIC -> valid
CLINIC_STAFF + CPU_CLINIC      -> valid
CLINIC_STAFF + null            -> invalid
CLINIC_STAFF + ""              -> invalid
COORDINATOR + null             -> valid
ADMIN + null                   -> valid
```

This test is optional if equivalent server-side coverage already exists elsewhere, because the primary production change is frontend behavior.

Do not add database integration tests solely for this UI bug unless implementation reveals a server-side regression.

## 13. Error Handling

The form must continue handling:

### Duplicate email

Preserve the existing API message:

```text
That email address is already in use.
```

### Invalid password

Use the returned password validation message when available.

### Invalid email

Use the returned email validation message when available.

### Unexpected server error

Fallback to the top-level API message.

Do not expose stack traces or internal server details in the UI.

## 14. Security Considerations

This change is primarily a UX correction, but the security boundary remains important.

Do not change the existing clinic-access authorization rules.

In particular:

```text
ADMIN
    -> may access both clinics

CLINIC_STAFF + KABALAKA_CLINIC
    -> KABALAKA clinic authorization

CLINIC_STAFF + CPU_CLINIC
    -> CPU clinic authorization
```

A clinic staff account must never gain global clinic access through this bug fix.

The implementation must therefore correct the frontend to match the backend—not modify the backend to accept `CLINIC_STAFF + Global`.

## 15. Files Expected to Change

Primary production file:

```text
src/components/settings/UsersManager.tsx
```

Primary test file:

```text
src/components/settings/UsersManager.test.tsx
```

Optional regression test only if needed:

```text
src/server/services/users.service.test.ts
```

Files that should normally remain unchanged:

```text
src/server/services/users.service.ts
src/app/api/users/route.ts
src/server/clinic-access.ts
database migrations
database schema
```

If implementation requires changing any of these protected areas, the reason should be investigated before proceeding because the current root cause does not require those changes.

## 16. Non-Goals

This fix does not:

- introduce global Clinic Staff accounts;
- redesign the Users page;
- change clinic authorization;
- change coordinator permissions;
- change administrator permissions;
- introduce additional clinic locations;
- modify employee authentication;
- modify student authentication;
- modify schedule access behavior;
- modify the clinic cross-access lock-state feature;
- migrate existing accounts.

## 17. Acceptance Criteria

- [ ] `Global` is not visible as a Clinic option when `Clinic staff` is selected.
- [ ] Clinic Staff can select `KABALAKA Clinic`.
- [ ] Clinic Staff can select `CPU Clinic`.
- [ ] Clinic Staff always submit a valid clinic code.
- [ ] Coordinator automatically uses `Global`.
- [ ] Administrator automatically uses `Global`.
- [ ] Global-role clinic selection is disabled.
- [ ] Switching from a global role back to Clinic Staff resets the clinic to `KABALAKA_CLINIC`.
- [ ] The backend still rejects Clinic Staff without a clinic assignment.
- [ ] API field-level validation errors can be displayed to the administrator.
- [ ] Existing valid users remain unaffected.
- [ ] No database migration is introduced.
- [ ] Existing clinic access authorization remains unchanged.
- [ ] Focused UsersManager tests pass.
- [ ] Full test suite passes.
- [ ] ESLint passes.
- [ ] Production build succeeds.

## 18. Verification Commands

Run the focused component test first:

```bash
npm test -- src/components/settings/UsersManager.test.tsx
```

Then run the complete regression checks:

```bash
npm test
npm run lint
npm run build
```

All three repository-wide checks must succeed before the bug fix is considered complete.

## 19. Expected Final User Experience

### Clinic Staff

```text
Full name            Email              Temporary password
[................]   [...............]  [...............]

Role
[Clinic staff ▼]

Clinic
[KABALAKA Clinic ▼]
 ├─ KABALAKA Clinic
 └─ CPU Clinic

[Add user]
```

There is no `Global` choice.

### Coordinator

```text
Role
[Coordinator ▼]

Clinic
[Global]  ← disabled
```

### Administrator

```text
Role
[Administrator ▼]

Clinic
[Global]  ← disabled
```

This makes the UI accurately represent the account model enforced by the MedClinic backend.
