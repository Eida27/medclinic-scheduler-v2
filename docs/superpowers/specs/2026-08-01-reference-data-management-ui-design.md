# Reference Data Management UI Design

**Date:** 2026-08-01  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Status:** Approved design

## 1. Summary

Revise the administrator **Reference data** page so it manages only the academic reference values required by student imports:

- Colleges
- Programs

Remove the **Priority groups** card from this page because automated scheduling already treats `OJT`, `TOUR`, and `SPECIALIZED` as non-regular student categories and applies first-come, first-served ordering to them. The existing priority-group database and API structures remain temporarily for compatibility with older coordinator-scheduling code, but they are no longer exposed through this page.

The revised page will also improve list usability by limiting each visible list area to approximately ten complete entries before enabling independent vertical scrolling. Text-based Delete buttons will be replaced by accessible red trash-can icon buttons while preserving the existing confirmation dialog and delete behavior.

## 2. Approved decisions

The following decisions are final for this design:

1. Remove Priority groups only from the Reference data interface. Retain the existing priority-group database table, repository functions, and API routes until a separate backend cleanup is designed.
2. Treat OJT, Tour, and Specialized students equally as non-regular students. Their scheduling order is first come, first served rather than category-ranked.
3. Display up to ten complete records in each reference list before independent vertical scrolling begins.
4. Replace the visible Delete text with an inline red SVG trash-can icon while retaining an accessible label, tooltip, and confirmation dialog.

## 3. Goals

The completed revision must:

- Simplify the Reference data page to Colleges and Programs.
- Prevent administrators from manually assigning misleading rank values to student categories.
- Preserve the existing automated scheduling categories and FCFS behavior.
- Use the available desktop width efficiently after removing the third card.
- Keep long college and program catalogs usable without excessively extending the full page.
- Allow Colleges and Programs to scroll independently.
- Replace large text delete actions with compact icon actions.
- Preserve keyboard access, screen-reader descriptions, focus visibility, and confirmation behavior.
- Preserve existing create and delete API behavior for Colleges and Programs.

## 4. Non-goals

This revision does not:

- Remove the `priority_groups` database table.
- Remove `/api/priority-groups`.
- Remove priority-group repository functions.
- Migrate older coordinator schedule items away from `priority_group_id`.
- Change the automated scheduling algorithm.
- Introduce category ranking between OJT, Tour, and Specialized.
- Change the student CSV structure.
- Add college or program editing.
- Add search, filtering, sorting controls, pagination, or bulk deletion.
- Change the existing confirmation dialog into immediate deletion.
- Use the uploaded trash-can PNG directly in the application bundle.

A future backend cleanup may remove legacy priority-group dependencies after every older coordinator-scheduling path has been reviewed and migrated.

## 5. Scheduling-category interpretation

### 5.1 Supported student categories

Automated schedule imports continue supporting:

```ts
"REGULAR" | "OJT" | "TOUR" | "SPECIALIZED"
```

### 5.2 Non-regular priority rule

The system groups the following categories into one non-regular priority class:

- OJT
- Tour
- Specialized

There is no category ordering such as OJT before Tour or Tour before Specialized.

Within the non-regular class, deterministic scheduling order is:

1. Import acceptance timestamp, ascending.
2. Original CSV source-row order, ascending, when acceptance timestamps are equal.
3. Stable request or student identifier as a final deterministic tie-breaker when required by the scheduler.

Regular students remain the lower-priority class and may be displaced according to the existing displacement rules.

### 5.3 Reference data separation

Student scheduling categories are operational scheduling inputs, not administrator-managed academic reference data. Therefore, they must not be presented as editable records beside Colleges and Programs.

The Reference data page is limited to values used to validate academic identity in imports:

- College name and code
- Program name and code
- Program-to-college relationship

## 6. Page structure

### 6.1 Header

The page header becomes:

```text
Title: Reference data
Description: Manage colleges and academic programs used for student imports.
```

The description must not mention coordinator priority groups.

### 6.2 Desktop layout

At the existing extra-large desktop breakpoint, render two equal-width cards:

```text
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ Colleges                     │  │ Programs                     │
│                              │  │                              │
│ Add-college form             │  │ Add-program form             │
│                              │  │                              │
│ Independently scrollable     │  │ Independently scrollable     │
│ list                         │  │ list                         │
└──────────────────────────────┘  └──────────────────────────────┘
```

The page must not retain a three-column grid or leave an empty third-column space.

### 6.3 Tablet and mobile layout

Below the desktop breakpoint, cards stack vertically:

```text
┌──────────────────────────────┐
│ Colleges                     │
└──────────────────────────────┘

┌──────────────────────────────┐
│ Programs                     │
└──────────────────────────────┘
```

Each card keeps its own internal list scrolling. The full card width must remain within the viewport without horizontal page overflow.

## 7. Card behavior

### 7.1 College card

The College card retains:

- Code input
- College name input
- Add college button
- Existing college list
- Delete confirmation workflow

### 7.2 Program card

The Program card retains:

- College selector populated from active colleges
- Program code input
- Program name input
- Add program button
- Existing program list
- College-name secondary text
- Delete confirmation workflow

### 7.3 Priority groups card removal

Remove all Priority groups page elements:

- Card title
- Group-name input
- Rank input
- Add priority button
- Priority group list
- Priority delete buttons
- Priority-specific delete-target label use on this page

The server page must not load priority groups solely to render this page.

## 8. Independent list scrolling

### 8.1 Threshold

Each card list follows this rule:

- Zero to ten entries: show all entries without a forced vertical scrollbar.
- Eleven or more entries: constrain the visible list region to approximately ten complete entry rows and enable vertical scrolling.

The threshold applies to rendered records, including inactive records if the repository returns them.

### 8.2 Independent containers

Colleges and Programs must use separate scroll containers. Scrolling Programs must not move the College list, and scrolling Colleges must not move the Program list.

### 8.3 Fixed content outside the list

The following remain outside the scrolling region:

- Card title
- Creation form
- Add button
- Page-level alerts

Only the record list scrolls.

### 8.4 Row sizing

Each row must have a consistent minimum height sufficient for:

- Primary code-and-name text
- Optional secondary metadata
- One 36-pixel icon button
- Comfortable vertical padding

The maximum list height should be derived from the intended ten-row presentation rather than a large arbitrary value that accidentally displays more than ten complete rows.

A practical implementation may use:

```text
minimum row height: approximately 64 px
maximum list height: approximately 640 px
```

Equivalent Tailwind values are acceptable when they preserve ten complete rows at the current typography and spacing.

### 8.5 Scroll usability

The list container should:

- Use `overflow-y-auto`.
- Use `overscroll-contain` where appropriate.
- Include a small right-side spacing allowance so the scrollbar does not overlap content.
- Preserve visible keyboard focus for action buttons while scrolling.
- Avoid clipping focus outlines.

## 9. Delete action design

### 9.1 Visual design

Replace each red Delete text button with an icon-only danger button containing an inline trash-can SVG.

The icon should visually match the supplied reference:

- Red danger treatment
- Simple outlined trash can
- Clear lid and container shape
- Vertical internal strokes
- No background image dependency

The application should use inline SVG rather than the attached PNG because SVG:

- Scales cleanly at different display densities.
- Inherits the button text color.
- Avoids shipping a large raster asset for a small interface icon.
- Can be hidden from screen readers while the button provides the accessible name.

### 9.2 Button size

Recommended dimensions:

```text
width: 36 px
height: 36 px
icon: approximately 20 px
```

The button remains large enough for keyboard and pointer use while occupying less horizontal space than the current Delete text button.

### 9.3 Accessibility

Every icon button must provide:

```tsx
aria-label={`Delete ${entryLabel(entry)}`}
title={`Delete ${entryLabel(entry)}`}
```

The SVG itself uses:

```tsx
aria-hidden="true"
```

The visible icon must not be the only source of meaning for assistive technology.

### 9.4 Confirmation workflow

Clicking the trash icon does not immediately delete the entry.

The existing confirmation dialog remains responsible for:

- Displaying the entry label.
- Warning that deletion cannot be undone.
- Providing Cancel and Delete actions.
- Displaying the pending state while deletion is in progress.
- Returning focus appropriately according to the existing dialog behavior.

## 10. Error and pending behavior

### 10.1 Create errors

Existing create errors remain displayed as page-level danger alerts.

### 10.2 Delete errors

Existing delete-error behavior remains:

- Close or reset the deletion target as currently implemented.
- Display the server-provided message when available.
- Fall back to a generic reference-deletion error.

### 10.3 Delete pending state

While a delete request is pending:

- Disable all visible trash-can buttons to avoid concurrent deletion attempts.
- Show the dialog pending label.
- Preserve the current list and page position until the server response is known.

### 10.4 Refresh behavior

Successful creation and deletion continue using the existing router refresh behavior so the server remains authoritative for displayed reference records.

## 11. Frontend component design

### 11.1 Page component

`src/app/(dashboard)/settings/reference-data/page.tsx` will:

- Load Colleges.
- Load Programs.
- Stop loading Priority groups for this page.
- Render the revised page description.
- Pass only `colleges` and `programs` to the manager component.

Conceptual server flow:

```ts
const [colleges, programs] = await Promise.all([
  listColleges(),
  listPrograms(),
]);
```

### 11.2 Manager component

`src/components/settings/ReferenceDataManager.tsx` remains the page-level client component.

Its responsibilities remain:

- College creation.
- Program creation.
- Deletion request state.
- Confirmation dialog state.
- Error display.
- Router refresh after successful writes.

Its props become:

```ts
type ReferenceDataManagerProps = {
  colleges: Entry[];
  programs: Entry[];
};
```

Priority-specific props and rendering are removed.

### 11.3 Shared list component

The existing internal list component may remain shared between Colleges and Programs.

It must add:

- Maximum ten-row visible height.
- Independent vertical scrolling.
- Icon-only delete buttons.
- Accessible list labeling when useful.

A separate reusable `TrashIcon` component may be declared in the same file unless the icon becomes useful elsewhere.

## 12. Backend compatibility

### 12.1 Retained structures

For this revision, retain:

- `priority_groups` table
- Priority-group seeds
- Priority-group repository functions
- Priority-group API route
- Existing foreign keys from older scheduling tables
- Existing coordinator schedule queries that join priority groups

### 12.2 Reason for retention

Older coordinator-scheduling paths still reference `priority_group_id`, priority-group names, and rank order. Removing those structures as part of a small UI revision could break older schedule-batch creation, detail views, validations, or ordering.

### 12.3 Future cleanup boundary

A separate design is required before deleting legacy priority-group structures. That design must inventory every dependency, define replacement data semantics, migrate existing records, update tests, and provide a safe database migration.

No implicit backend deletion is allowed under this approved specification.

## 13. Data and API behavior

### 13.1 College creation

No contract change:

```text
POST /api/colleges
```

### 13.2 Program creation

No contract change:

```text
POST /api/programs
```

### 13.3 College deletion

No contract change:

```text
DELETE /api/colleges
body: { id }
```

### 13.4 Program deletion

No contract change:

```text
DELETE /api/programs
body: { id }
```

### 13.5 Priority API

The Priority groups endpoint remains available but is unused by the Reference data page after this revision.

## 14. Accessibility requirements

The revised page must:

- Keep semantic form controls and labels or accessible placeholders consistent with the existing component system.
- Give each trash button a unique descriptive accessible name.
- Hide decorative SVG paths from assistive technology.
- Preserve visible focus indicators.
- Allow keyboard activation with Enter and Space through native button behavior.
- Keep confirmation-dialog controls keyboard accessible.
- Avoid color-only meaning by using a conventional trash icon plus accessible text.
- Maintain sufficient danger-button contrast.
- Avoid trapping keyboard users inside list scroll containers.

## 15. Responsive requirements

- Two equal columns at the established desktop breakpoint.
- One column below that breakpoint.
- No empty space reserved for Priority groups.
- No horizontal page overflow caused by long program names.
- Primary text may wrap naturally.
- Delete icons remain fixed-size and must not shrink.
- Text content receives `min-width: 0` so long names wrap instead of pushing the action outside the card.
- List scrolling remains usable on desktop and touch devices.

## 16. Testing strategy

### 16.1 Page tests

Verify that the Reference data page:

- Calls `listColleges()`.
- Calls `listPrograms()`.
- Does not require `listPriorityGroups()` for rendering.
- Displays the revised description.
- Passes only Colleges and Programs to the manager.
- Does not render a Priority groups heading.

### 16.2 Component rendering tests

Verify that `ReferenceDataManager`:

- Renders Colleges and Programs cards.
- Does not render Priority groups.
- Uses a responsive two-column desktop layout.
- Renders existing forms and add buttons.
- Renders college and program entries.

### 16.3 Scrolling tests

Verify that:

- Each list has its own overflow container.
- The list container uses the approved maximum height.
- Lists with more than ten entries remain inside the constrained region.
- College and Program lists use distinct containers.
- Forms remain outside the scrollable list container.

DOM tests do not need to simulate browser scrollbar painting; they must assert the structural classes and container boundaries that implement the behavior.

### 16.4 Delete-icon tests

Verify that:

- The visible Delete text is absent from each row.
- Each entry has a button named `Delete <entry label>`.
- The button contains an SVG marked `aria-hidden="true"`.
- Clicking the icon opens the confirmation dialog.
- Cancel closes the dialog without making a DELETE request.
- Confirm sends the existing DELETE request body.
- Buttons are disabled while deletion is pending.
- Failed deletion shows an error.
- Successful deletion refreshes the route.

### 16.5 Scheduling regression tests

Existing tests for these categories must continue passing:

- Regular
- OJT
- Tour
- Specialized

Existing FCFS ordering and priority-displacement tests must remain unchanged unless a test incorrectly assumes category rank ordering among non-regular students.

### 16.6 Static verification

Run:

```bash
npm test -- <reference-data-focused-tests>
npm run lint
npm run build
```

The implementation is not complete until all commands succeed.

## 17. Expected implementation files

Primary files:

```text
src/app/(dashboard)/settings/reference-data/page.tsx
src/components/settings/ReferenceDataManager.tsx
```

Expected test files, depending on the current test structure:

```text
src/app/(dashboard)/settings/reference-data/page.test.tsx
src/components/settings/ReferenceDataManager.test.tsx
```

Possible existing test fixtures may require updates when the `priorities` prop is removed.

## 18. Rollout sequence

1. Add or update page tests to expect only Colleges and Programs.
2. Add or update manager tests for the two-card layout.
3. Add tests for independent constrained list containers.
4. Add tests for accessible icon-only delete actions.
5. Remove the Priority groups page query and prop.
6. Remove the Priority groups card and form.
7. Change the grid from three desktop columns to two.
8. Add independent ten-row list scrolling.
9. Add the inline trash icon and compact danger button.
10. Run focused tests, the full relevant suite, lint, and production build.
11. Inspect the final diff to confirm no priority-group backend structures were removed.

## 19. Acceptance criteria

The revision is accepted only when:

- The Reference data page displays exactly two management cards: Colleges and Programs.
- Priority groups are not loaded or rendered by this page.
- The page description refers only to colleges and academic programs used for imports.
- OJT, Tour, and Specialized remain valid automated scheduling categories.
- OJT, Tour, and Specialized remain equally prioritized through FCFS rather than category rank.
- The priority-group database, repository, and API remain intact.
- The desktop layout uses two equal-width columns.
- The cards stack cleanly on smaller screens.
- Each card shows up to ten complete entries before its own vertical scrolling begins.
- Scrolling one list does not scroll the other list.
- Card titles and creation forms remain visible while their list scrolls.
- Row Delete text is replaced with a red inline SVG trash icon.
- Every trash button has an entry-specific accessible label and tooltip.
- Clicking the trash icon opens the existing confirmation dialog.
- Existing College and Program create/delete behavior remains unchanged.
- No unrelated scheduling, database, API, or migration changes are included.
- Focused tests, lint, and production build pass.
