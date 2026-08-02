import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/Card";
import type { AcademicYearState } from "@/lib/academic-year";
import type { HistoricalReportFilters } from "@/lib/historical-compliance-report";
import type { HistoricalComplianceBreakdowns } from "@/server/repositories/historical-compliance-report.repository";
import { reportHref } from "./report-query";

type Metrics = {
  totalStudents: number;
  fullyComplied: number;
  attentionStudents: number;
  complianceRate: number;
};

function BreakdownTable({
  title,
  groupLabel,
  state,
  rows,
}: {
  title: string;
  groupLabel: string;
  state: AcademicYearState;
  rows: Array<Metrics & { key: string; content: React.ReactNode }>;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="px-5 pt-5"><CardTitle>{title}</CardTitle></div>
      <div className="overflow-x-auto">
        <table className="mt-3 w-full text-left text-sm" aria-label={title}>
          <thead className="bg-cpu-navy-soft/70">
            <tr>
              <th className="px-5 py-3">{groupLabel}</th>
              <th className="px-5 py-3 text-right">Total</th>
              <th className="px-5 py-3 text-right">Complied</th>
              <th className="px-5 py-3 text-right">{state === "CLOSED" ? "Did Not Comply" : "Pending"}</th>
              <th className="px-5 py-3 text-right">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="px-5 py-3 font-semibold text-ink">{row.content}</th>
                <td className="px-5 py-3 text-right">{row.totalStudents}</td>
                <td className="px-5 py-3 text-right">{row.fullyComplied}</td>
                <td className="px-5 py-3 text-right">{row.attentionStudents}</td>
                <td className="px-5 py-3 text-right">{row.complianceRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ReportBreakdowns({
  breakdowns,
  filters,
  programs,
  state,
}: {
  breakdowns: HistoricalComplianceBreakdowns;
  filters: HistoricalReportFilters;
  programs: Array<{ id: string; collegeId: string }>;
  state: AcademicYearState;
}) {
  const selectedProgram = programs.find((program) => program.id === filters.programId);
  return (
    <section aria-label="Academic breakdowns" className="grid gap-5 xl:grid-cols-3">
      <BreakdownTable
        title="College breakdown"
        groupLabel="College"
        state={state}
        rows={breakdowns.colleges.map((row) => ({
          ...row,
          key: row.collegeId ?? row.collegeName,
          content: row.collegeId ? (
            <Link
              href={reportHref(filters, {
                collegeId: row.collegeId,
                programId: selectedProgram?.collegeId === row.collegeId
                  ? filters.programId
                  : undefined,
                page: 1,
              })}
              aria-label={`Filter by ${row.collegeName}`}
              className="text-cpu-navy underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
            >
              {row.collegeName}
            </Link>
          ) : row.collegeName,
        }))}
      />
      <BreakdownTable
        title="Program breakdown"
        groupLabel="Program"
        state={state}
        rows={breakdowns.programs.map((row) => ({
          ...row,
          key: row.programId ?? `${row.collegeName}:${row.programName}`,
          content: `${row.programCode ? `${row.programCode} — ` : ""}${row.programName}`,
        }))}
      />
      <BreakdownTable
        title="Year-level breakdown"
        groupLabel="Year level"
        state={state}
        rows={breakdowns.yearLevels.map((row) => ({
          ...row,
          key: String(row.yearLevel ?? "unknown"),
          content: row.yearLevel === null ? "Not recorded" : `Year ${row.yearLevel}`,
        }))}
      />
    </section>
  );
}
