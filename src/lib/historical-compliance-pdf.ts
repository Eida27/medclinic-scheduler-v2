import { manilaCalendarDate, type AcademicYearState } from "./academic-year";
import {
  historicalComplianceLabel,
  historicalDataQualityLabel,
  type HistoricalDataQuality,
  type HistoricalReportFilters,
  type HistoricalRequirementStatus,
} from "./historical-compliance-report";
import type {
  HistoricalComplianceBreakdowns,
  HistoricalComplianceReportItem,
  HistoricalComplianceSummary,
  HistoricalReportDimensions,
} from "@/server/repositories/historical-compliance-report.repository";

export type HistoricalCompliancePdfSource = {
  academicYear: {
    startYear: number;
    label: string;
    closingDate: string;
    state: AcademicYearState;
  };
  filters: HistoricalReportFilters;
  total: number;
  summary: HistoricalComplianceSummary;
  breakdowns: HistoricalComplianceBreakdowns;
  dimensions: HistoricalReportDimensions;
  items: HistoricalComplianceReportItem[];
};

export type HistoricalCompliancePdfModel = ReturnType<typeof buildHistoricalCompliancePdfModel>;

const requirementLabels: Record<HistoricalRequirementStatus, string> = {
  UNSCHEDULED: "Unscheduled",
  PENDING: "Pending",
  COMPLETED: "Completed",
  NO_SHOW: "No Show",
  RESCHEDULED: "Rescheduled",
  CANCELLED: "Cancelled",
  AWAITING_RESCHEDULE: "Awaiting Reschedule",
};

const sortLabels: Record<HistoricalReportFilters["sort"], string> = {
  college_asc: "College (A-Z)",
  college_desc: "College (Z-A)",
  program_asc: "Program (A-Z)",
  program_desc: "Program (Z-A)",
  year_asc: "Year level (ascending)",
  year_desc: "Year level (descending)",
  name_asc: "Student name (A-Z)",
  name_desc: "Student name (Z-A)",
  attention_first: "Attention first",
  completed_first: "Completed first",
};

function asciiSafe(value: string) {
  return value
    .replace(/[–—]/g, "-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function slug(value: string) {
  return asciiSafe(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function generationLabel(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  }).format(value);
}

function appointmentLabel(date: string | null, status: HistoricalRequirementStatus) {
  return `${date ? dateLabel(date) : "No appointment"}\n${requirementLabels[status]}`;
}

function overallFilterLabel(value: HistoricalReportFilters["overallStatus"]) {
  return value === "DID_NOT_COMPLY"
    ? "Did Not Comply"
    : value === "PENDING_COMPLIANCE"
      ? "Pending Compliance"
      : value === "COMPLIED" ? "Complied" : "All";
}

export function buildHistoricalCompliancePdfFilename(input: {
  academicYearLabel: string;
  overallStatus?: HistoricalReportFilters["overallStatus"];
  generatedAt: Date;
}) {
  const date = manilaCalendarDate(input.generatedAt);
  const status = input.overallStatus ? `-${slug(overallFilterLabel(input.overallStatus))}` : "";
  return `cpu-medclinic-compliance-report-${slug(input.academicYearLabel)}${status}-${date}.pdf`;
}

export function buildHistoricalCompliancePdfModel(
  report: HistoricalCompliancePdfSource,
  actor: { userId: string; fullName: string },
  generatedAt: Date,
) {
  const college = report.dimensions.colleges.find(({ id }) => id === report.filters.collegeId);
  const program = report.dimensions.programs.find(({ id }) => id === report.filters.programId);
  const programLabel = program
    ? `${program.code ? `${program.code} - ` : ""}${program.name}`
    : "All";
  const stateLabel = {
    OPEN: "Open",
    CLOSING_SOON: "Closing Soon",
    CLOSED: "Closed",
  }[report.academicYear.state];

  return {
    provenance: "Central Philippine University MedClinic",
    title: "Historical Compliance Report",
    academicYear: {
      startYear: report.academicYear.startYear,
      label: asciiSafe(report.academicYear.label),
      closingDate: dateLabel(report.academicYear.closingDate),
      state: stateLabel,
    },
    generated: {
      at: generationLabel(generatedAt),
      iso: generatedAt.toISOString(),
      by: `${asciiSafe(actor.fullName)} (${asciiSafe(actor.userId)})`,
    },
    appliedFilters: [
      { label: "Student", value: asciiSafe(report.filters.search?.trim() || "All") },
      { label: "Overall", value: overallFilterLabel(report.filters.overallStatus) },
      { label: "Laboratory", value: report.filters.laboratoryStatus ? requirementLabels[report.filters.laboratoryStatus] : "All" },
      { label: "Physical Examination", value: report.filters.physicalExamStatus ? requirementLabels[report.filters.physicalExamStatus] : "All" },
      { label: "College", value: asciiSafe(college?.name ?? "All") },
      { label: "Program", value: asciiSafe(programLabel) },
      { label: "Year Level", value: report.filters.yearLevel?.toString() ?? "All" },
      { label: "Data Quality", value: report.filters.dataQuality ? historicalDataQualityLabel(report.filters.dataQuality) : "All" },
      { label: "Sort", value: sortLabels[report.filters.sort] },
    ],
    summary: { ...report.summary },
    breakdowns: [
      ...report.breakdowns.colleges.map((row) => ({
        level: "College" as const,
        group: asciiSafe(row.collegeName),
        ...row,
      })),
      ...report.breakdowns.programs.map((row) => ({
        level: "Program" as const,
        group: asciiSafe(`${row.programCode ? `${row.programCode} - ` : ""}${row.programName}`),
        ...row,
      })),
      ...report.breakdowns.yearLevels.map((row) => ({
        level: "Year Level" as const,
        group: row.yearLevel === null ? "Not recorded" : `Year ${row.yearLevel}`,
        ...row,
      })),
    ],
    details: report.items.map((row) => ({
      student: `${asciiSafe(row.studentName)}\n${asciiSafe(row.studentNumber)}`,
      college: asciiSafe(row.collegeName),
      program: asciiSafe(`${row.programCode ? `${row.programCode} - ` : ""}${row.programName}`),
      yearLevel: row.yearLevel?.toString() ?? "Not recorded",
      laboratory: appointmentLabel(row.laboratoryAppointmentDate, row.laboratoryStatus),
      physicalExam: appointmentLabel(row.physicalExamAppointmentDate, row.physicalExamStatus),
      overall: historicalComplianceLabel(row.overallStatus),
      dataQuality: historicalDataQualityLabel(row.dataQuality as HistoricalDataQuality),
    })),
  };
}
