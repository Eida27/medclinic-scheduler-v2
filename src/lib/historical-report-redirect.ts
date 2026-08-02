import {
  historicalReportSorts,
  type HistoricalDataQuality,
  type HistoricalOverallStatusFilter,
  type HistoricalReportSort,
  type HistoricalRequirementStatus,
} from "./historical-compliance-report";

type LegacyReportParams = Record<string, string | undefined>;

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
  const academicYearStart = positiveInteger(params.academicYearStart, 2020, 2100);
  if (academicYearStart) query.set("academicYearStart", academicYearStart);

  const search = (params.studentNumber ?? params.search)?.trim();
  if (search) query.set("search", search);

  const mappedOverallStatus = source === "appointments" && params.overallStatus === "COMPLETE"
    ? "COMPLIED"
    : member(params.overallStatus, overallStatuses);
  if (mappedOverallStatus) query.set("overallStatus", mappedOverallStatus);

  const laboratoryStatus = member(params.laboratoryStatus, requirementStatuses);
  if (laboratoryStatus) query.set("laboratoryStatus", laboratoryStatus);
  const physicalExamStatus = member(params.physicalExamStatus, requirementStatuses);
  if (physicalExamStatus) query.set("physicalExamStatus", physicalExamStatus);

  if (params.collegeId && uuidPattern.test(params.collegeId)) {
    query.set("collegeId", params.collegeId);
  }
  if (params.programId && uuidPattern.test(params.programId)) {
    query.set("programId", params.programId);
  }

  const yearLevel = positiveInteger(params.yearLevel, 1, 6);
  if (yearLevel) query.set("yearLevel", yearLevel);
  const dataQuality = member(params.dataQuality, dataQualities);
  if (dataQuality) query.set("dataQuality", dataQuality);
  const sort = member(params.sort, sorts);
  if (sort) query.set("sort", sort);
  const page = positiveInteger(params.page, 1, Number.MAX_SAFE_INTEGER);
  if (page) query.set("page", page);

  return `/reports${query.size ? `?${query.toString()}` : ""}`;
}
