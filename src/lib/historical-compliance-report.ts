import type { AcademicYearState } from "./academic-year";

export const REPORT_PAGE_SIZE = 150;

export const historicalReportSorts = [
  "college_asc",
  "college_desc",
  "program_asc",
  "program_desc",
  "year_asc",
  "year_desc",
  "name_asc",
  "name_desc",
  "attention_first",
  "completed_first",
] as const;
export type HistoricalReportSort = typeof historicalReportSorts[number];

export type HistoricalRequirementStatus =
  | "UNSCHEDULED"
  | "PENDING"
  | "COMPLETED"
  | "NO_SHOW"
  | "RESCHEDULED"
  | "CANCELLED"
  | "AWAITING_RESCHEDULE";

export type HistoricalComplianceClassification =
  | "COMPLIED"
  | "PENDING_COMPLIANCE"
  | "DID_NOT_COMPLY_LABORATORY"
  | "DID_NOT_COMPLY_PHYSICAL_EXAM"
  | "DID_NOT_COMPLY_BOTH";

export type HistoricalDataQuality =
  | "VERIFIED_HISTORICAL"
  | "RECOVERED_HISTORICAL"
  | "MIGRATED_INCOMPLETE";

export type HistoricalOverallStatusFilter =
  | "COMPLIED"
  | "PENDING_COMPLIANCE"
  | "DID_NOT_COMPLY";

export type HistoricalReportFilters = {
  academicYearStart: number | null;
  search?: string;
  overallStatus?: HistoricalOverallStatusFilter;
  laboratoryStatus?: HistoricalRequirementStatus;
  physicalExamStatus?: HistoricalRequirementStatus;
  collegeId?: string;
  programId?: string;
  yearLevel?: number;
  dataQuality?: HistoricalDataQuality;
  sort: HistoricalReportSort;
  page: number;
  limit: typeof REPORT_PAGE_SIZE;
  offset: number;
};

const requirementStatuses = new Set<HistoricalRequirementStatus>([
  "UNSCHEDULED",
  "PENDING",
  "COMPLETED",
  "NO_SHOW",
  "RESCHEDULED",
  "CANCELLED",
  "AWAITING_RESCHEDULE",
]);
const overallStatuses = new Set<HistoricalOverallStatusFilter>([
  "COMPLIED",
  "PENDING_COMPLIANCE",
  "DID_NOT_COMPLY",
]);
const dataQualities = new Set<HistoricalDataQuality>([
  "VERIFIED_HISTORICAL",
  "RECOVERED_HISTORICAL",
  "MIGRATED_INCOMPLETE",
]);
const sorts = new Set<HistoricalReportSort>(historicalReportSorts);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function integer(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function member<T extends string>(value: unknown, values: Set<T>): T | undefined {
  return typeof value === "string" && values.has(value as T) ? value as T : undefined;
}

export function parseHistoricalReportQuery(input: Record<string, unknown>): HistoricalReportFilters {
  const parsedYear = integer(input.academicYearStart);
  const academicYearStart = parsedYear !== null && parsedYear >= 2020 && parsedYear <= 2100
    ? parsedYear
    : null;
  const search = typeof input.search === "string" ? input.search.trim() : "";
  const pageValue = integer(input.page);
  const page = pageValue !== null && pageValue > 0 ? pageValue : 1;
  const yearLevelValue = integer(input.yearLevel);
  const yearLevel = yearLevelValue !== null && yearLevelValue >= 1 && yearLevelValue <= 6
    ? yearLevelValue
    : undefined;
  const collegeId = typeof input.collegeId === "string" && uuidPattern.test(input.collegeId)
    ? input.collegeId
    : undefined;
  const programId = typeof input.programId === "string" && uuidPattern.test(input.programId)
    ? input.programId
    : undefined;

  return {
    academicYearStart,
    ...(search ? { search } : {}),
    ...(member(input.overallStatus, overallStatuses) && {
      overallStatus: member(input.overallStatus, overallStatuses),
    }),
    ...(member(input.laboratoryStatus, requirementStatuses) && {
      laboratoryStatus: member(input.laboratoryStatus, requirementStatuses),
    }),
    ...(member(input.physicalExamStatus, requirementStatuses) && {
      physicalExamStatus: member(input.physicalExamStatus, requirementStatuses),
    }),
    ...(collegeId && { collegeId }),
    ...(programId && { programId }),
    ...(yearLevel && { yearLevel }),
    ...(member(input.dataQuality, dataQualities) && {
      dataQuality: member(input.dataQuality, dataQualities),
    }),
    sort: member(input.sort, sorts) ?? "college_asc",
    page,
    limit: REPORT_PAGE_SIZE,
    offset: (page - 1) * REPORT_PAGE_SIZE,
  };
}

export function classifyHistoricalCompliance(
  state: AcademicYearState,
  laboratory: HistoricalRequirementStatus,
  physicalExam: HistoricalRequirementStatus,
): HistoricalComplianceClassification {
  const laboratoryComplete = laboratory === "COMPLETED";
  const physicalExamComplete = physicalExam === "COMPLETED";
  if (laboratoryComplete && physicalExamComplete) return "COMPLIED";
  if (state !== "CLOSED") return "PENDING_COMPLIANCE";
  if (!laboratoryComplete && physicalExamComplete) return "DID_NOT_COMPLY_LABORATORY";
  if (laboratoryComplete) return "DID_NOT_COMPLY_PHYSICAL_EXAM";
  return "DID_NOT_COMPLY_BOTH";
}

export function historicalComplianceLabel(value: HistoricalComplianceClassification) {
  return {
    COMPLIED: "Complied",
    PENDING_COMPLIANCE: "Pending Compliance",
    DID_NOT_COMPLY_LABORATORY: "Did Not Comply - Laboratory",
    DID_NOT_COMPLY_PHYSICAL_EXAM: "Did Not Comply - Physical Examination",
    DID_NOT_COMPLY_BOTH: "Did Not Comply - Both Requirements",
  }[value];
}

export function historicalDataQualityLabel(value: HistoricalDataQuality) {
  return {
    VERIFIED_HISTORICAL: "Verified Historical",
    RECOVERED_HISTORICAL: "Recovered Historical",
    MIGRATED_INCOMPLETE: "Migrated - Incomplete Historical Data",
  }[value];
}
