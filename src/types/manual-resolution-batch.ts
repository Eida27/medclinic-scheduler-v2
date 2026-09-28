export type ManualCaseToken = { caseId: string; expectedOptimisticToken: string };
export type SelectedManualCase = ManualCaseToken & {
  studentNumber: string;
  academicYearStart: number;
  needsLaboratory: boolean;
  needsPhysicalExam: boolean;
  hasLaboratory: boolean;
  hasPhysicalExam: boolean;
};
export type ManualService = "LABORATORY" | "PHYSICAL_EXAM";
export type ManualSelectionResult = {
  items: Array<ManualCaseToken & { studentNumber: string; academicYearStart: number;
    laboratory?: { status: string } | null; physicalExam?: { status: string } | null }>;
  total: number;
  eligibleCount: number;
  blockedCount: number;
  blockedReasons: Record<string, number>;
  tooMany: boolean;
};
export type ManualAvailability = {
  month: string;
  service: ManualService;
  required: number;
  days: Array<{
    date: string;
    state: "AVAILABLE" | "FULL" | "INSUFFICIENT" | "UNAVAILABLE";
    issues: Array<{ code: string; message: string }>;
    capacity: Array<{ clinicId: string; used: number; maximum: number | null; available: number; required: number; projected: number }>;
  }>;
};
export type ManualBatchPayload = {
  cases: ManualCaseToken[];
  replaceRelatedServices: boolean;
  preservationAcknowledged: true;
  laboratoryDate?: string;
  physicalExamDate?: string;
  reason: string;
};
export type ManualBatchPreview = {
  rows: Array<{
    caseId: string;
    studentNumber: string;
    laboratory: { oldDate: string; newDate: string; action: "MOVE" | "PRESERVE" } | null;
    physicalExam: { oldDate: string; newDate: string; action: "MOVE" | "PRESERVE" } | null;
    retainedTests: string[];
    issues: Array<{ code: string; message: string }>;
  }>;
  capacity: Array<{ clinicId: string; service: ManualService; date: string; used: number; maximum: number | null; required: number; projected: number }>;
  studentCount: number;
  appointmentCount: number;
  expiresAt: string | null;
  previewToken: string | null;
};
