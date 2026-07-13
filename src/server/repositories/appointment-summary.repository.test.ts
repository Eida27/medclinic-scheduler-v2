import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/server/db/pool", () => ({ query }));

import {
  appointmentSummaryReport,
  type AppointmentSummarySort,
} from "./appointment-summary.repository";

function mockReportQueries() {
  query
    .mockResolvedValueOnce({ rows: [{ count: "1" }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [{
        total: 1,
        physical_completed: 0,
        laboratory_completed: 0,
        pending_any: 1,
      }],
    });
}

describe("appointmentSummaryReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReportQueries();
  });

  it("builds a published-only student summary with filter-safe pagination", async () => {
    const report = await appointmentSummaryReport({
      search: "Aaron",
      appointmentDate: "2026-07-29",
      appointmentStatus: "PENDING",
      collegeId: "11111111-1111-1111-1111-111111111111",
      programId: "22222222-2222-2222-2222-222222222222",
      priorityGroupId: "33333333-3333-3333-3333-333333333333",
      physicalExamStatus: "COMPLETED",
      laboratoryStatus: "PENDING",
      overallStatus: "INCOMPLETE",
      sort: "name_desc",
      page: 2,
      limit: 150,
      offset: 150,
    });

    expect(report).toEqual({
      items: [],
      total: 1,
      summary: {
        totalStudents: 1,
        physicalCompleted: 0,
        laboratoryCompleted: 0,
        pendingAny: 1,
      },
    });
    expect(query).toHaveBeenCalledTimes(3);

    const countSql = query.mock.calls[0][0] as string;
    const itemSql = query.mock.calls[1][0] as string;
    expect(countSql).toContain("a.is_published=TRUE");
    expect(countSql).toContain("a.status IN ('PENDING','COMPLETED','NO_SHOW')");
    expect(countSql).toContain("item_appointment.is_published=TRUE");
    expect(countSql).toContain("summary_rows.\"overallStatus\"=$9");
    expect(itemSql).toContain(
      'ORDER BY summary_rows."lastName" DESC, summary_rows."firstName" DESC, summary_rows."studentNumber" DESC',
    );
    expect(query.mock.calls[1][1]).toEqual([
      "%Aaron%",
      "2026-07-29",
      "PENDING",
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
      "COMPLETED",
      "PENDING",
      "INCOMPLETE",
      150,
      150,
    ]);
  });

  it.each<[AppointmentSummarySort, string]>([
    ["upcoming_asc", 'summary_rows."nextSchedule" ASC NULLS LAST'],
    ["upcoming_desc", 'summary_rows."nextSchedule" DESC NULLS LAST'],
    ["name_asc", 'summary_rows."lastName" ASC, summary_rows."firstName" ASC'],
    ["name_desc", 'summary_rows."lastName" DESC, summary_rows."firstName" DESC'],
    ["attention_first", "CASE summary_rows.\"overallStatus\" WHEN 'FOLLOW_UP' THEN 0 WHEN 'INCOMPLETE' THEN 1 ELSE 2 END"],
    ["completed_first", "CASE summary_rows.\"overallStatus\" WHEN 'COMPLETE' THEN 0 WHEN 'INCOMPLETE' THEN 1 ELSE 2 END"],
  ])("uses the deterministic %s order", async (sort, expectedOrder) => {
    await appointmentSummaryReport({ page: 1, limit: 150, offset: 0, sort });

    const itemSql = query.mock.calls[1][0] as string;
    expect(itemSql).toContain(expectedOrder);
    expect(itemSql).toContain('summary_rows."studentNumber"');
  });
});
