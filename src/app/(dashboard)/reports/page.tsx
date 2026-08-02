import { notFound, redirect } from "next/navigation";
import { ReportBreakdowns } from "@/components/reports/ReportBreakdowns";
import { ReportExportButton } from "@/components/reports/ReportExportButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { ReportPagination } from "@/components/reports/ReportPagination";
import { ReportRecordsTable } from "@/components/reports/ReportRecordsTable";
import { ReportSummaryCards } from "@/components/reports/ReportSummaryCards";
import {
  buildReportSearchParams,
  reportHref,
} from "@/components/reports/report-query";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { AppError } from "@/lib/errors";
import {
  parseHistoricalReportQuery,
  REPORT_PAGE_SIZE,
} from "@/lib/historical-compliance-report";
import { requireUser } from "@/server/auth/current-user";
import { listAcademicYears } from "@/server/services/academic-years.service";
import { getHistoricalComplianceReport } from "@/server/services/historical-compliance-report.service";

type ReportsSearchParams = Record<string, string | string[] | undefined>;

function yearStateLabel(state: "OPEN" | "CLOSING_SOON" | "CLOSED") {
  return { OPEN: "Open", CLOSING_SOON: "Closing Soon", CLOSED: "Closed" }[state];
}

function closingDateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<ReportsSearchParams>;
}) {
  try {
    await requireUser(["ADMIN"]);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) notFound();
    throw error;
  }
  const params = await searchParams;
  const parsed = parseHistoricalReportQuery(params);

  if (parsed.academicYearStart === null) {
    const years = await listAcademicYears();
    return (
      <>
        <PageHeader
          title="Reports"
          description="Review historical appointment compliance, identify students with incomplete requirements, and export filtered records."
          actions={<ReportExportButton query="" disabled />}
        />
        <Card role="status" className="border-cpu-gold/60 bg-amber-50">
          <h2 className="font-bold text-ink">Academic year required</h2>
          <p className="mt-1 text-sm text-muted">Select a configured academic year to generate the report.</p>
        </Card>
        <ReportFilters
          key={buildReportSearchParams(parsed).toString()}
          years={years.map(({ startYear, label }) => ({ startYear, label }))}
          filters={parsed}
          dimensions={{ colleges: [], programs: [], yearLevels: [] }}
        />
      </>
    );
  }

  let years;
  let report;
  try {
    [years, report] = await Promise.all([
      listAcademicYears(),
      getHistoricalComplianceReport(params),
    ]);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const selectedProgram = report.dimensions.programs.find((program) => (
    program.id === report.filters.programId
  ));
  const programIsInvalid = report.filters.programId && (
    !selectedProgram
    || (report.filters.collegeId && selectedProgram.collegeId !== report.filters.collegeId)
  );
  if (programIsInvalid) {
    redirect(reportHref(report.filters, { programId: undefined, page: 1 }));
  }

  const totalPages = Math.ceil(report.total / REPORT_PAGE_SIZE);
  if (report.total > 0 && report.filters.page > totalPages) {
    redirect(reportHref(report.filters, { page: totalPages }));
  }

  const exportQuery = buildReportSearchParams(report.filters, { page: 1 }).toString();
  const yearState = report.academicYear.state;
  const hasRecords = report.total > 0;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Review historical appointment compliance, identify students with incomplete requirements, and export filtered records."
        actions={<ReportExportButton query={exportQuery} disabled={!hasRecords} />}
      />
      <Card className="flex flex-col gap-3 border-cpu-navy/15 bg-cpu-navy-soft/35 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Selected academic year</p>
          <h2 className="mt-1 text-xl font-black text-cpu-navy">{report.academicYear.label}</h2>
          <p className="mt-1 text-sm text-muted">Closing date: {closingDateLabel(report.academicYear.closingDate)}</p>
        </div>
        <Badge tone={yearState === "CLOSED" ? "neutral" : yearState === "CLOSING_SOON" ? "warning" : "success"}>
          {yearStateLabel(yearState)}
        </Badge>
      </Card>
      <ReportSummaryCards state={yearState} summary={report.summary} />
      {report.summary.migratedIncomplete > 0 ? (
        <Card role="status" className="border-amber-300 bg-amber-50 text-sm text-amber-950">
          <span className="font-bold">Historical data notice:</span> {report.summary.migratedIncomplete} records use migrated or incomplete historical data. Review the data-quality label in the detailed table.
        </Card>
      ) : null}
      <ReportBreakdowns
        breakdowns={report.breakdowns}
        filters={report.filters}
        programs={report.dimensions.programs}
        state={yearState}
      />
      <ReportFilters
        key={buildReportSearchParams(report.filters).toString()}
        years={years.map(({ startYear, label }) => ({ startYear, label }))}
        filters={report.filters}
        dimensions={report.dimensions}
      />
      {report.total === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-muted">No historical compliance records match the selected filters.</p>
        </Card>
      ) : (
        <ReportRecordsTable items={report.items} />
      )}
      <ReportPagination filters={report.filters} total={report.total} />
    </>
  );
}
