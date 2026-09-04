import { manilaCalendarDate, type AcademicYearState } from "./academic-year";
import {
  historicalComplianceLabel,
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

export function pdfAsciiSafe(value: string) {
  return value
    .replace(/[–—]/g, "-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function slug(value: string) {
  return pdfAsciiSafe(value)
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

function compareText(left: string, right: string) {
  return left.localeCompare(right, "en", { sensitivity: "base" }) || left.localeCompare(right);
}

function historicalCollegeLabels(dimensions: HistoricalReportDimensions) {
  const namesById = new Map<string, Set<string>>();
  for (const college of dimensions.colleges) {
    const names = namesById.get(college.id) ?? new Set<string>();
    names.add(college.name);
    namesById.set(college.id, names);
  }
  return new Map([...namesById].map(([id, names]) => [
    id,
    [...names].sort(compareText).join(" / "),
  ]));
}

function historicalProgramLabel(
  dimensions: HistoricalReportDimensions,
  programId: string | undefined,
  collegeId: string | undefined,
) {
  if (!programId) return "All";

  const colleges = historicalCollegeLabels(dimensions);
  const variants = dimensions.programs.filter((program) => (
    program.id === programId && (!collegeId || program.collegeId === collegeId)
  ));
  const uniqueVariants = variants.filter((program, index) => variants.findIndex((candidate) => (
    candidate.collegeId === program.collegeId
    && candidate.code === program.code
    && candidate.name === program.name
  )) === index);
  uniqueVariants.sort((left, right) => (
    compareText(colleges.get(left.collegeId) ?? left.collegeId,
      colleges.get(right.collegeId) ?? right.collegeId)
    || compareText(left.code ?? "", right.code ?? "")
    || compareText(left.name, right.name)
    || left.collegeId.localeCompare(right.collegeId)
  ));
  const spansColleges = new Set(uniqueVariants.map((variant) => variant.collegeId)).size > 1;

  return uniqueVariants.map((variant) => {
    const program = `${variant.code ? `${variant.code} - ` : ""}${variant.name}`;
    return spansColleges
      ? `${program} (${colleges.get(variant.collegeId) ?? variant.collegeId})`
      : program;
  }).join(" / ") || "All";
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
  const colleges = historicalCollegeLabels(report.dimensions);
  const collegeLabel = report.filters.collegeId
    ? colleges.get(report.filters.collegeId) ?? "All"
    : "All";
  const programLabel = historicalProgramLabel(
    report.dimensions,
    report.filters.programId,
    report.filters.collegeId,
  );
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
      label: report.academicYear.label,
      closingDate: dateLabel(report.academicYear.closingDate),
      state: stateLabel,
    },
    generated: {
      at: generationLabel(generatedAt),
      iso: generatedAt.toISOString(),
      by: `${actor.fullName} (${actor.userId})`,
    },
    appliedFilters: [
      { label: "Student", value: report.filters.search?.trim() || "All" },
      { label: "Overall", value: overallFilterLabel(report.filters.overallStatus) },
      { label: "Laboratory", value: report.filters.laboratoryStatus ? requirementLabels[report.filters.laboratoryStatus] : "All" },
      { label: "Physical Examination", value: report.filters.physicalExamStatus ? requirementLabels[report.filters.physicalExamStatus] : "All" },
      { label: "College", value: collegeLabel },
      { label: "Program", value: programLabel },
      { label: "Year Level", value: report.filters.yearLevel?.toString() ?? "All" },
      { label: "Sort", value: sortLabels[report.filters.sort] },
    ],
    summary: { ...report.summary },
    breakdowns: [
      ...report.breakdowns.colleges.map((row) => ({
        level: "College" as const,
        group: row.collegeName,
        ...row,
      })),
      ...report.breakdowns.programs.map((row) => ({
        level: "Program" as const,
        group: `${row.programCode ? `${row.programCode} - ` : ""}${row.programName}`,
        ...row,
      })),
      ...report.breakdowns.yearLevels.map((row) => ({
        level: "Year Level" as const,
        group: row.yearLevel === null ? "Not recorded" : `Year ${row.yearLevel}`,
        ...row,
      })),
    ],
    details: report.items.map((row) => ({
      student: `${row.studentName}\n${row.studentNumber}`,
      college: row.collegeName,
      program: `${row.programCode ? `${row.programCode} - ` : ""}${row.programName}`,
      yearLevel: row.yearLevel?.toString() ?? "Not recorded",
      laboratory: appointmentLabel(row.laboratoryAppointmentDate, row.laboratoryStatus),
      physicalExam: appointmentLabel(row.physicalExamAppointmentDate, row.physicalExamStatus),
      overall: historicalComplianceLabel(row.overallStatus),
    })),
  };
}
