# Align Overall Appointment Status Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Center the appointments table's Overall header and status badges within the final column.

**Architecture:** Keep the existing semantic table and automatic column sizing. Add Tailwind's `text-center` utility only to the Overall `<th>` and corresponding `<td>`, with a focused rendering test that protects the column-specific alignment.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS, Vitest, Testing Library

## Global Constraints

- Center only the `Overall` column header and body cells.
- Keep `Student`, `Laboratory`, and `Physical exam` alignment unchanged.
- Do not introduce fixed column widths or `table-fixed`.
- Preserve status values, badge tones, row data, filters, sorting, pagination, repository queries, APIs, and routes.
- Browser acceptance uses `1365x768` and `768x900`; the Overall badge center must be within one pixel of its header cell center with no new overflow or clipping.

---

### Task 1: Center the Overall column

**Files:**
- Modify: `src/app/(dashboard)/appointments/page.test.tsx`
- Modify: `src/app/(dashboard)/appointments/page.tsx`

**Interfaces:**
- Consumes: the existing four-column appointments summary table and `Badge` rendering.
- Produces: the same table/data interface with column-specific `text-center` presentation on Overall only.

- [ ] **Step 1: Write the failing alignment assertions**

In the existing populated-table test, retain the exact four-header and four-cell assertions, store the row cells, and assert column-specific alignment:

```tsx
const headers = screen.getAllByRole("columnheader");
expect(headers).toHaveLength(4);
expect(headers.map((header) => header.textContent)).toEqual([
  "Student",
  "Laboratory",
  "Physical exam",
  "Overall",
]);
headers.slice(0, 3).forEach((header) => {
  expect(header).not.toHaveClass("text-center");
});
expect(headers[3]).toHaveClass("text-center");

const row = screen.getByRole("row", { name: /Aaron Abad/ });
const cells = within(row).getAllByRole("cell");
expect(cells).toHaveLength(4);
cells.slice(0, 3).forEach((cell) => {
  expect(cell).not.toHaveClass("text-center");
});
expect(cells[3]).toHaveClass("text-center");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- "src/app/(dashboard)/appointments/page.test.tsx" --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because the fourth header and/or fourth cell does not contain `text-center`.

- [ ] **Step 3: Apply the minimal presentation change**

Update only the Overall header and cell classes:

```tsx
<th className="px-5 py-3 text-center">Overall</th>
```

```tsx
<td className="px-5 py-4 text-center">
  <Badge tone={statusTone(item.overallStatus)}>{item.overallStatus}</Badge>
</td>
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm test -- "src/app/(dashboard)/appointments/page.test.tsx" --maxWorkers=1 --no-file-parallelism
```

Expected: PASS with 1 test file and 7 tests.

- [ ] **Step 5: Run regression and production checks**

Run:

```powershell
npm test -- --maxWorkers=1 --no-file-parallelism
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 6: Verify the rendered geometry in Browser**

Start the worktree app on an isolated port, open `/appointments` in the in-app Browser, and test `1365x768` and `768x900`. For each viewport, compare the fourth `<th>` center with the Overall badge center and require an absolute difference of at most one pixel. Confirm the first three columns retain their existing alignment and no new overflow or clipping is introduced.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- "src/app/(dashboard)/appointments/page.test.tsx" "src/app/(dashboard)/appointments/page.tsx"
git commit -m "fix: align overall appointment status"
```
