import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/server/db/pool", () => ({ query }));

import {
  appointmentSummaryReport,
} from "./appointment-summary.repository";
import type { AppointmentSummarySort } from "@/components/appointments/appointment-summary";

function mockReportQueries() {
  query
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
      laboratoryStatus: "UNSCHEDULED",
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
    expect(query).toHaveBeenCalledTimes(2);

    const itemSql = query.mock.calls[0][0] as string;
    expect(itemSql).toContain("current_effective_appointments");
    expect(itemSql).not.toContain("FROM exam_results result");
    expect(itemSql).not.toContain("FROM laboratory_results result");
    expect(itemSql).toContain("item_appointment.is_published=TRUE");
    expect(itemSql).toContain("summary_rows.\"overallStatus\"=$9");
    expect(itemSql).toContain(
      'ORDER BY summary_rows."lastName" DESC, summary_rows."firstName" DESC, summary_rows."studentNumber" DESC',
    );
    expect(query.mock.calls[0][1]).toEqual([
      "%Aaron%",
      "2026-07-29",
      "PENDING",
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
      "COMPLETED",
      "UNSCHEDULED",
      "INCOMPLETE",
      150,
      150,
    ]);
  });

  it("uses equivalent attendance-filter values for rows and metrics before pagination", async () => {
    await appointmentSummaryReport({
      physicalExamStatus: "COMPLETED",
      laboratoryStatus: "UNSCHEDULED",
      sort: "attention_first",
      page: 3,
      limit: 20,
      offset: 40,
    });

    const itemSql = query.mock.calls[0][0] as string;
    const summarySql = query.mock.calls[1][0] as string;
    const itemValues = query.mock.calls[0][1] as unknown[];
    const summaryValues = query.mock.calls[1][1] as unknown[];
    const itemWhere = itemSql.match(/FROM summary_rows\s+WHERE ([\s\S]+?)\s+ORDER BY/)?.[1];
    const summaryWhere = summarySql.match(/FROM summary_rows\s+WHERE ([\s\S]+)$/)?.[1];

    expect(itemWhere).toBe(summaryWhere);
    expect(itemWhere).toContain('summary_rows."physicalExamStatus"=$1');
    expect(itemWhere).toContain('summary_rows."laboratoryStatus"=$2');
    expect(itemValues.slice(0, -2)).toEqual(summaryValues);
    expect(summaryValues).toEqual(["COMPLETED", "UNSCHEDULED"]);
    expect(itemValues).toEqual(["COMPLETED", "UNSCHEDULED", 20, 40]);
    expect(itemSql).toContain(
      "CASE summary_rows.\"overallStatus\" WHEN 'INCOMPLETE' THEN 0 ELSE 1 END",
    );
  });

  it.each<[AppointmentSummarySort, string]>([
    ["upcoming_asc", 'summary_rows."nextSchedule" ASC NULLS LAST'],
    ["upcoming_desc", 'summary_rows."nextSchedule" DESC NULLS LAST'],
    ["name_asc", 'summary_rows."lastName" ASC, summary_rows."firstName" ASC'],
    ["name_desc", 'summary_rows."lastName" DESC, summary_rows."firstName" DESC'],
    ["attention_first", "CASE summary_rows.\"overallStatus\" WHEN 'INCOMPLETE' THEN 0 ELSE 1 END"],
    ["completed_first", "CASE summary_rows.\"overallStatus\" WHEN 'COMPLETE' THEN 0 WHEN 'INCOMPLETE' THEN 1 ELSE 2 END"],
  ])("uses the deterministic %s order", async (sort, expectedOrder) => {
    await appointmentSummaryReport({ page: 1, limit: 150, offset: 0, sort });

    const itemSql = query.mock.calls[0][0] as string;
    expect(itemSql).toContain(expectedOrder);
    expect(itemSql).toContain('summary_rows."studentNumber"');
  });
});
