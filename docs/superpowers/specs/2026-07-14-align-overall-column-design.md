# Align Overall Appointment Status Column

## Problem

The appointments summary table inherits `text-left` from the table element. After the `Next schedule` column was removed, the auto-sized final `Overall` column keeps its header and badges at the left edge while leaving spare width on the right, making the column appear shifted.

## Design

- Center only the `Overall` column header and body cells by adding the existing Tailwind `text-center` utility to the corresponding `<th>` and `<td>` elements.
- Keep `Student`, `Laboratory`, and `Physical exam` alignment unchanged.
- Keep automatic table sizing and horizontal overflow behavior; do not introduce fixed column widths or `table-fixed`.
- Preserve all status values, badge tones, row data, filters, sorting, pagination, repository queries, APIs, and routes.

## Testing and Acceptance

- Extend the appointments page test first so it requires `text-center` on the fourth column header and fourth row cell while confirming the first three columns retain their existing alignment.
- Run the focused page test before implementation and confirm it fails because the Overall header and cell are not centered.
- Apply the two class changes and rerun the focused test to green.
- Run the full test suite, lint, and production build.
- Use the in-app Browser on `/appointments` at the desktop width represented by the supplied screenshot and at a narrow viewport. Confirm the Overall header and badge share the final column's horizontal center, the other columns are unchanged, and no new overflow or clipping appears.

## Scope

This is a presentation-only adjustment in the appointments page and its focused test. It does not change public interfaces, data flow, error handling, or backend behavior.
