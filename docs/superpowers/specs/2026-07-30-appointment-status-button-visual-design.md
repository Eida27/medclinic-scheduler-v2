# Appointment Status Button Visual Design

**Date:** 2026-07-30  
**Repository:** `Eida27/medclinic-scheduler-v2`  
**Scope:** Laboratory and Physical Exam appointment tables

## Objective

Simplify the clickable appointment status controls in the Laboratory and Physical Exam tabs so they display only the current status while retaining the existing status-transition behavior, confirmation rules, error handling, and accessibility.

The visual design is based on three compact pill buttons:

- **Completed** — bright green background with white text
- **Pending** — medium gray background with white text
- **No-show** — bright red background with white text

The buttons must feel modern through restrained hover, focus, shadow, lift, scale, and shine effects without distracting administrators during repetitive appointment updates.

## Existing Behavior to Preserve

The shared `AppointmentQuickStatusButton` remains the single status-control component used by both clinic tables.

The existing interaction rules remain unchanged:

1. Clicking **Pending** immediately marks the appointment as **Completed**.
2. Clicking **Completed** restores the appointment to its recorded previous status.
3. Clicking **No-show** opens the existing confirmation dialog before correcting it to **Completed**.
4. A completion that originated from **No-show** continues to require confirmation before restoration.
5. While an update is in progress, duplicate submissions remain blocked and the button displays `Updating...`.
6. Existing inline API and connection errors remain visible and retryable.
7. Existing server-side validation remains authoritative; the UI must not perform an unsupported optimistic status change.

No API contract, database rule, appointment-transition rule, or confirmation-dialog behavior is changed by this work.

## Visible Labels and Accessibility

The button's visible text is limited to the status itself:

- `Pending`
- `Completed`
- `No-show`

The longer action description remains available through the button's accessible name using `aria-label`.

Examples:

- Visible: `Pending`  
  Accessible name: `Pending — click to mark completed`
- Visible: `Completed`  
  Accessible name: `Completed — click to restore pending`
- Visible: `Completed`  
  Accessible name: `Completed — click to restore no-show`
- Visible: `No-show`  
  Accessible name: `No-show — click to correct as completed`

When the previous status is unavailable, the disabled button remains visibly labeled `Completed`, while its accessible name explains that the previous status is unavailable.

## Shared Component Design

The existing `AppointmentQuickStatusButton` will be updated rather than duplicated or replaced.

The component configuration should separate:

- `visibleLabel` — short text rendered inside the button
- `accessibleLabel` — complete description assigned to `aria-label`
- status transition action
- expected current status
- visual tone
- optional confirmation-dialog configuration

This keeps display concerns separate from transition behavior and avoids deriving visible text from instructional accessibility content.

## Base Button Appearance

All three statuses use the same base pill structure:

- fully rounded shape
- compact content-based width
- consistent minimum height
- balanced horizontal and vertical padding
- centered, bold white text
- subtle default shadow
- clear keyboard focus ring
- pointer cursor only when interactive
- disabled cursor and reduced emphasis when unavailable

The button should remain appropriately sized for a data-table cell and must not expand to the long accessible label.

### Status Tones

#### Pending

- medium neutral gray background
- white text
- slightly darker gray on hover
- neutral focus ring

#### Completed

- bright green background
- white text
- slightly darker green on hover
- green focus ring

#### No-show

- bright red background
- white text
- slightly darker red on hover
- red focus ring

Color choices must maintain readable contrast for white text and should use the project's existing Tailwind utility palette unless a project token already provides the intended appearance.

## Hover, Focus, and Shine Effects

The enhanced interaction applies only to enabled buttons.

On mouse hover or visible keyboard focus:

1. The button moves upward slightly.
2. The button scales up very subtly.
3. The shadow becomes stronger.
4. A soft diagonal highlight sweeps once from left to right across the button.
5. The background may darken slightly to reinforce interactivity.

The movement must remain restrained so table rows do not appear unstable. The recommended effect is approximately a one-pixel lift with a scale near `1.02`.

### Shine Implementation

The shine should be CSS-only and implemented through a clipped pseudo-element or equivalent decorative layer:

- the button uses `position: relative` and `overflow: hidden`
- the decorative shine layer does not intercept pointer events
- the highlight is a semi-transparent diagonal gradient
- its resting position remains outside the left edge
- hover and `focus-visible` move it across and beyond the right edge
- the sweep runs once per hover or focus entry rather than looping continuously

The shine is decorative and must not be announced to assistive technology.

## Motion and Loading Rules

- Disabled buttons do not lift, scale, or play the shine animation.
- Buttons marked busy during submission do not lift, scale, or replay the shine.
- The busy state continues to display `Updating...`.
- The button remains disabled while the request is pending.
- The transition duration should feel responsive rather than slow.
- Users who request reduced motion should receive little or no translation, scaling, or shine movement through `prefers-reduced-motion` support.

## Error Handling

The existing error behavior remains unchanged:

- request failures do not change the authoritative visible status
- errors appear below the button when no confirmation dialog is open
- dialog-related errors remain inside the confirmation dialog
- the button becomes interactive again after a failed request
- a retry uses the same validated status-transition request

The decorative effects must not obscure, replace, or delay error feedback.

## Responsive and Table Behavior

- The pill remains compact and content-sized on desktop and smaller viewports.
- The shine effect is clipped within the rounded boundary.
- Hover scaling must not overlap adjacent table content noticeably.
- The component remains left-aligned within its current table-cell wrapper unless the existing table design specifies another alignment.
- Laboratory and Physical Exam tabs receive identical status styling because they share the same component.

## Testing Requirements

Update the component tests to verify:

1. The visible text is only `Pending`, `Completed`, or `No-show`.
2. The button retains the complete accessible name for each transition.
3. Pending, Completed, and No-show receive their intended solid status-tone classes.
4. The shared interactive classes for shadow, lift, scale, focus, clipping, and shine are present.
5. Loading still displays `Updating...`, disables the button, and prevents duplicate requests.
6. The existing direct and confirmed transition payloads remain unchanged.
7. Existing error and retry behavior remains unchanged.
8. A completed appointment without restoration history remains disabled while visibly showing `Completed` and exposing an explanatory accessible name.

Tests should assert behavior and important semantic classes without depending on fragile full class-string equality.

## Files Expected to Change

The implementation should primarily affect:

- `src/components/appointments/AppointmentQuickStatusButton.tsx`
- `src/components/appointments/AppointmentQuickStatusButton.test.tsx`

Additional global CSS should be avoided unless Tailwind utilities cannot express the one-time shine animation cleanly. A component-local pseudo-element approach is preferred to prevent unrelated styling changes.

## Acceptance Criteria

The design is complete when:

- Laboratory and Physical Exam rows display compact green, gray, and red pill buttons matching the approved references.
- Visible labels contain only the current status.
- Detailed action descriptions remain available to screen readers.
- Enabled buttons have a subtle lift, tiny scale increase, stronger shadow, and one-time shine sweep on hover and keyboard focus.
- Disabled and loading buttons do not animate.
- Reduced-motion preferences are respected.
- All existing appointment status-transition behavior, confirmations, loading protection, and errors continue to work.
- Relevant automated tests pass without weakening existing behavioral coverage.
