import {
  historicalReportSorts,
  type HistoricalDataQuality,
  type HistoricalOverallStatusFilter,
  type HistoricalReportSort,
  type HistoricalRequirementStatus,
} from "./historical-compliance-report";

type LegacyQueryValue = string | string[] | undefined;
export type LegacyReportParams = Record<string, LegacyQueryValue>;

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

function first(value: LegacyQueryValue) {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined, minimum: number, maximum: number) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? String(parsed)
    : undefined;
}

function member<T extends string>(value: string | undefined, values: Set<T>) {
  return value && values.has(value as T) ? value as T : undefined;
}

export function historicalReportRedirectTarget(
  params: LegacyReportParams,
  source: "appointments" | "compliance",
) {
  const query = new URLSearchParams();
  const academicYearStart = positiveInteger(first(params.academicYearStart), 2020, 2100);
  if (academicYearStart) query.set("academicYearStart", academicYearStart);

  const search = (first(params.studentNumber) ?? first(params.search))?.trim();
  if (search) query.set("search", search);

  const overallStatus = first(params.overallStatus);
  const mappedOverallStatus = source === "appointments" && overallStatus === "COMPLETE"
    ? "COMPLIED"
    : member(overallStatus, overallStatuses);
  if (mappedOverallStatus) query.set("overallStatus", mappedOverallStatus);

  const laboratoryStatus = member(first(params.laboratoryStatus), requirementStatuses);
  if (laboratoryStatus) query.set("laboratoryStatus", laboratoryStatus);
  const physicalExamStatus = member(first(params.physicalExamStatus), requirementStatuses);
  if (physicalExamStatus) query.set("physicalExamStatus", physicalExamStatus);

  const collegeId = first(params.collegeId);
  if (collegeId && uuidPattern.test(collegeId)) {
    query.set("collegeId", collegeId);
  }
  const programId = first(params.programId);
  if (programId && uuidPattern.test(programId)) {
    query.set("programId", programId);
  }

  const yearLevel = positiveInteger(first(params.yearLevel), 1, 6);
  if (yearLevel) query.set("yearLevel", yearLevel);
  const dataQuality = member(first(params.dataQuality), dataQualities);
  if (dataQuality) query.set("dataQuality", dataQuality);
  const sort = member(first(params.sort), sorts);
  if (sort) query.set("sort", sort);
  const page = positiveInteger(first(params.page), 1, Number.MAX_SAFE_INTEGER);
  if (page) query.set("page", page);

  return `/reports${query.size ? `?${query.toString()}` : ""}`;
}
