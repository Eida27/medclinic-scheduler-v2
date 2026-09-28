// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/types/roles";
const mocks = vi.hoisted(() => ({ query: vi.fn(), load: vi.fn(), apply: vi.fn(), destination: vi.fn(), occupancy: vi.fn(), blocked: vi.fn(), lock: vi.fn(), boundary: vi.fn() }));
vi.mock("@/server/db/pool", () => ({ transaction: (fn: (client: unknown) => unknown) => fn({ query: mocks.query }) }));
vi.mock("./clinic-manual-resolution-locks", () => ({ lockClinicManualResolutionCases: mocks.lock }));
vi.mock("@/server/repositories/effective-appointment-scope-lock.repository", () => ({ lockSchedulingMutationQueue: mocks.lock }));
vi.mock("@/server/repositories/academic-years.repository", () => ({ lockAcademicYearSchedulingBoundary: mocks.boundary }));
vi.mock("@/server/repositories/appointments.repository", () => ({ getManualRescheduleDestinationState: mocks.destination }));
vi.mock("@/server/schedule/scheduling-occupancy.repository", () => ({ getInternalOccupancy: mocks.occupancy, internalOccupancyPredicate: () => "appointment.status IN ('PENDING','COMPLETED')" }));
vi.mock("@/server/repositories/scheduling-blocked-dates.repository", () => ({ isSchedulingDateBlocked: mocks.blocked }));
vi.mock("./clinic-calendar.service", () => ({ loadAppointmentStates: mocks.load, resolveClinicClosureManualCaseWithClient: mocks.apply,
  currentAssignmentBlock: (rows: Array<{ isManuallyLocked: boolean; resultProtectionState: { type: string } }>) => rows.some((row) => row.isManuallyLocked || row.resultProtectionState.type === "PROTECTED") ? { code: "PROTECTED_RESULTS_EXIST", message: "Protected" } : null }));
import { previewManualResolutionBatch, resolveManualResolutionBatch, getManualResolutionAvailability } from "./manual-resolution-batch.service";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const actor = { userId: uuid(99), role: "ADMIN" } as SessionUser;
function fixtures(count=1) {
  const cases = Array.from({ length: count }, (_,i) => ({ id: uuid(i+1),studentNumber:`S${i}`,academicYearStart:2026,status:"OPEN",optimisticToken:uuid(i+101),reasonCode:"EMERGENCY_CLOSURE",laboratoryId:uuid(i+201),physicalExamId:uuid(i+301),schedulePairId:uuid(i+401) }));
  const appointments = cases.flatMap((row) => [
    { id:row.laboratoryId,clinicId:uuid(700),studentNumber:row.studentNumber,scheduleType:"LABORATORY",appointmentDate:"2026-09-01",status:"COMPLETED",isPublished:true,isManuallyLocked:false,resultProtectionState:{type:"PROTECTED"},schedulePairId:row.schedulePairId,scheduleCycleStart:2026,rescheduledFrom:null,ovpsaBatchId:null,ovpsaRevisionId:null,ovpsaServiceReservationId:null },
    { id:row.physicalExamId,clinicId:uuid(701),studentNumber:row.studentNumber,scheduleType:"PHYSICAL_EXAM",appointmentDate:"2026-10-06",status:"AWAITING_RESCHEDULE",isPublished:false,isManuallyLocked:false,resultProtectionState:{type:"CLEAR"},schedulePairId:row.schedulePairId,scheduleCycleStart:2026,rescheduledFrom:null,ovpsaBatchId:null,ovpsaRevisionId:null,ovpsaServiceReservationId:null },
  ]);
  mocks.load.mockResolvedValue(appointments);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM users") ? [{ role:"ADMIN",verified:true,mustChangePassword:false,credentialVersion:1 }]
    : sql.includes("FROM clinic_closure_manual_cases") ? cases : sql.startsWith("SELECT * FROM appointments") ? appointments : [] }));
  const payload = { cases:cases.map((row) => ({caseId:row.id,expectedOptimisticToken:row.optimisticToken})),physicalExamDate:"2026-10-06",replaceRelatedServices:false,preservationAcknowledged:true as const,reason:"New shared schedule" };
  return { cases,appointments,payload };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
  mocks.boundary.mockResolvedValue({startYear:2026,closingDate:"2027-07-31"});
  mocks.destination.mockResolvedValue({maxDailyCapacity:12,cycleClosingDate:"2027-07-31",usedCapacity:0});
  mocks.occupancy.mockResolvedValue(0);mocks.blocked.mockResolvedValue(false);mocks.apply.mockResolvedValue({notificationWarningCount:0});
});
afterEach(() => vi.useRealTimers());
describe("bulk manual planner", () => {
  it("preserves completed protected Lab, admits 12 and rejects 13 without writes", async () => {
    let fixture=fixtures(12);
    let result=await previewManualResolutionBatch(fixture.payload,actor);
    expect(result.previewToken).toBeTypeOf("string");expect(result.capacity[0].projected).toBe(12);
    expect(result.rows[0].laboratory?.action).toBe("PRESERVE");
    expect(mocks.query.mock.calls.some(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false);
    fixture=fixtures(13); result=await previewManualResolutionBatch(fixture.payload,actor);
    expect(result.previewToken).toBeNull();expect(result.rows).toHaveLength(13);expect(result.capacity[0].projected).toBe(13);
  });
  it("never discounts awaiting sources already on the destination", async () => {
    const {payload}=fixtures(5);mocks.occupancy.mockResolvedValue(8);
    const result=await previewManualResolutionBatch(payload,actor);
    expect(result.capacity[0]).toMatchObject({used:8,departing:0,required:5,projected:13});expect(result.previewToken).toBeNull();
  });
  it("blocks coordinated OVPSA membership, cross-cycle and stale tokens", async () => {
    const fixture=fixtures(2);fixture.cases[0].reasonCode="OVPSA_LABORATORY_PROTECTED";fixture.cases[1].academicYearStart=2025;fixture.payload.cases[0].expectedOptimisticToken=uuid(900);
    const result=await previewManualResolutionBatch(fixture.payload,actor);
    expect(result.previewToken).toBeNull();expect(result.rows[0].issues.map((issue)=>issue.code)).toEqual(expect.arrayContaining(["OVPSA_BATCH_RECOVERY_REQUIRED","MANUAL_CROSS_CYCLE","MANUAL_CASE_STALE"]));
  });
  it("blocks requested protected related services and invalid pair ordering", async () => {
    const fixture=fixtures();fixture.appointments[0].status="PENDING";
    const result=await previewManualResolutionBatch({...fixture.payload,replaceRelatedServices:true,laboratoryDate:"2026-10-07"},actor);
    expect(result.previewToken).toBeNull();expect(result.rows[0].issues.map((issue)=>issue.code)).toEqual(expect.arrayContaining(["PROTECTED_RESULTS_EXIST","PAIR_ORDER_VIOLATION"]));
  });
  it("rejects changed capacity after preview before invoking the writer", async () => {
    const {payload}=fixtures();const preview=await previewManualResolutionBatch(payload,actor);mocks.occupancy.mockResolvedValue(1);
    await expect(resolveManualResolutionBatch({...payload,requestId:uuid(999),previewToken:preview.previewToken},actor)).rejects.toMatchObject({code:"MANUAL_PREVIEW_STALE"});expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("applies through the client-aware writer and saves an exact authorized replay", async () => {
    const {payload}=fixtures(2);const preview=await previewManualResolutionBatch(payload,actor);
    const outcome=await resolveManualResolutionBatch({...payload,requestId:uuid(999),previewToken:preview.previewToken},actor);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    const saved=mocks.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO clinical_mutation_requests"))!;
    mocks.query.mockImplementation(async (sql:string)=>({rows:sql.includes("FROM users")?[{role:"ADMIN",verified:true,mustChangePassword:false}]:sql.includes("FROM clinical_mutation_requests")?[{action:"BULK_MANUAL_RESOLUTION",payload_hash:saved[1][2],outcome}]:[]}));
    vi.setSystemTime(new Date("2026-09-28T00:00:00Z"));
    expect(await resolveManualResolutionBatch({...payload,requestId:uuid(999),previewToken:preview.previewToken},actor)).toEqual(outcome);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    await expect(resolveManualResolutionBatch({...payload,reason:"Changed input",requestId:uuid(999),previewToken:preview.previewToken},actor)).rejects.toMatchObject({code:"CLINICAL_REQUEST_CONFLICT"});
  });
  it("rechecks live Administrator authority before replay", async () => {
    const {payload}=fixtures();mocks.query.mockResolvedValue({rows:[{role:"COORDINATOR",verified:true,mustChangePassword:false}]});
    await expect(resolveManualResolutionBatch({...payload,requestId:uuid(999),previewToken:"x".repeat(30)},actor)).rejects.toMatchObject({status:403});expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("returns every day including empty weekdays and distinct full/insufficient states", async () => {
    const {payload}=fixtures(5);mocks.occupancy.mockResolvedValue(8);
    const result=await getManualResolutionAvailability({cases:payload.cases,replaceRelatedServices:false,month:"2026-10",service:"PHYSICAL_EXAM"},actor);
    expect(result.days).toHaveLength(31);expect(result.days.find((day)=>day.date==="2026-10-06")?.state).toBe("INSUFFICIENT");expect(result.days.find((day)=>day.date==="2026-10-04")?.state).toBe("UNAVAILABLE");
  });
});
