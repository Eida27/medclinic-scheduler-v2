import { createHash } from "node:crypto";
import type {
  GeneratePairedScheduleInput,
  GeneratePairedScheduleOutput,
  PairedScheduleCapacity,
  PairedScheduleRequest,
} from "./types";

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isWeekday(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function dailyCeiling(capacity: PairedScheduleCapacity) {
  return Math.max(0, Math.min(capacity.safeDailyCapacity, capacity.maxDailyCapacity));
}

function firstEligibleDate({
  startDate,
  endDate,
  blockedDates,
  load,
  capacity,
}: {
  startDate: string;
  endDate: string;
  blockedDates: Set<string>;
  load: Map<string, number>;
  capacity: PairedScheduleCapacity;
}) {
  const ceiling = dailyCeiling(capacity);
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (!isWeekday(date) || blockedDates.has(date)) continue;
    if ((load.get(date) ?? 0) < ceiling) return date;
  }
  return null;
}

function tier(category: PairedScheduleRequest["category"]) {
  return category === "REGULAR" ? 2 : 1;
}

function orderedRequests(requests: PairedScheduleRequest[]) {
  return [...requests].sort((left, right) => (
    tier(left.category) - tier(right.category)
    || left.acceptedAt.localeCompare(right.acceptedAt)
    || left.sourceRowOrder - right.sourceRowOrder
    || left.studentNumber.localeCompare(right.studentNumber)
    || left.requestId.localeCompare(right.requestId)
  ));
}

function deterministicPairId(request: PairedScheduleRequest) {
  const hex = createHash("sha256")
    .update(`${request.requestId}\0${request.studentNumber}\0${request.acceptedAt}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function generatePairedSchedule(
  input: GeneratePairedScheduleInput,
): GeneratePairedScheduleOutput {
  const laboratoryLoad = new Map(
    Object.entries(input.existingLaboratoryLoad),
  );
  const physicalExamLoad = new Map(
    Object.entries(input.existingPhysicalExamLoad),
  );
  const blockedLaboratoryDates = new Set(input.blockedLaboratoryDates);
  const blockedPhysicalExamDates = new Set(input.blockedPhysicalExamDates);
  const output: GeneratePairedScheduleOutput = {
    assignments: [],
    unscheduledRequestIds: [],
  };

  for (const request of orderedRequests(input.requests)) {
    const laboratoryDate = firstEligibleDate({
      startDate: request.windowStart,
      endDate: input.searchEndDate,
      blockedDates: blockedLaboratoryDates,
      load: laboratoryLoad,
      capacity: input.laboratoryCapacity,
    });
    const physicalExamDate = laboratoryDate && firstEligibleDate({
      startDate: addDays(laboratoryDate, 1),
      endDate: input.searchEndDate,
      blockedDates: blockedPhysicalExamDates,
      load: physicalExamLoad,
      capacity: input.physicalExamCapacity,
    });

    if (!laboratoryDate || !physicalExamDate) {
      output.unscheduledRequestIds.push(request.requestId);
      continue;
    }

    laboratoryLoad.set(laboratoryDate, (laboratoryLoad.get(laboratoryDate) ?? 0) + 1);
    physicalExamLoad.set(physicalExamDate, (physicalExamLoad.get(physicalExamDate) ?? 0) + 1);
    output.assignments.push({
      requestId: request.requestId,
      studentNumber: request.studentNumber,
      schedulePairId: deterministicPairId(request),
      laboratoryDate,
      physicalExamDate,
    });
  }

  return output;
}
