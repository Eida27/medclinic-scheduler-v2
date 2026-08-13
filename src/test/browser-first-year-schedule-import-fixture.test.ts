// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  FIRST_YEAR_IMPORT_ACCEPTANCE,
  firstYearAcceptanceCsvContents,
} from "../../scripts/browser-first-year-ovpsa-fixture";

describe("First Year import Browser fixture", () => {
  it("builds 280 ordered Year-1 members with an exact 150/130 multi-college boundary", () => {
    const rows = firstYearAcceptanceCsvContents().trim().split("\r\n");
    expect(rows).toHaveLength(281);
    expect(rows[1]).toContain("86-0001-91,Order001");
    expect(rows[150]).toContain("86-0150-91,Order150");
    expect(rows[150]).toContain("College of Computer Studies,BSIT,1");
    expect(rows[151]).toContain("86-0151-91,Order151");
    expect(rows[151]).toContain("College of Engineering,BSCE,1");
    expect(rows[280]).toContain("86-0280-91,Order280");
    expect(FIRST_YEAR_IMPORT_ACCEPTANCE.expected).toMatchObject({
      capacity: 150,
      skippedProtectedDate: "2026-09-29",
      allocations: [
        { date: "2026-09-30", studentCount: 150 },
        { date: "2026-10-01", studentCount: 130 },
      ],
      displacementTotal: 4,
    });
  });
});
