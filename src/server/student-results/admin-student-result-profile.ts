import type {
  AttendanceStatus,
  ScheduleType,
} from "@/server/repositories/current-effective-appointments.repository";

export type CurrentSubmissionState =
  | "FINALIZED"
  | "INVALIDATED"
  | "NOT_SUBMITTED";
export type AdminSubmissionProgress =
  | "AWAITING_RESUBMISSION"
  | "FULLY_SUBMITTED"
  | "PARTIALLY_SUBMITTED"
  | "NOT_SUBMITTED";

export type AdminResultFile = {
  id: string;
  originalFilename: string;
  detectedMimeType: string;
  byteSize: number;
};

export type AdminResultSubmission = {
  id: string;
  appointmentId: string;
  appointmentDate: string;
  resultType: ScheduleType;
  status: "FINALIZED" | "INVALIDATED";
  finalizedAt: Date;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
  lastActivityAt: Date;
  fileCount: number;
  totalBytes: number;
  files: AdminResultFile[];
};

export type AdminCurrentResultSection = {
  resultType: ScheduleType;
  appointment: {
    id: string;
    appointmentDate: string;
    status: Exclude<AttendanceStatus, "UNSCHEDULED">;
  } | null;
  state: CurrentSubmissionState;
  submission: AdminResultSubmission | null;
};

export type AdminStudentResultListItem = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  progress: AdminSubmissionProgress;
  latestActivityAt: Date;
  laboratory: Pick<AdminCurrentResultSection, "state"> & { fileCount: number };
  physicalExam: Pick<AdminCurrentResultSection, "state"> & { fileCount: number };
};

export type AdminStudentResultProfile = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  progress: AdminSubmissionProgress;
  latestActivityAt: Date | null;
  laboratory: AdminCurrentResultSection;
  physicalExam: AdminCurrentResultSection;
  history: AdminResultSubmission[];
};

export function currentSubmissionState(
  submission: Pick<AdminResultSubmission, "status"> | null,
): CurrentSubmissionState {
  return submission?.status ?? "NOT_SUBMITTED";
}

export function combinedSubmissionProgress(
  laboratory: CurrentSubmissionState,
  physicalExam: CurrentSubmissionState,
): AdminSubmissionProgress {
  if (laboratory === "INVALIDATED" || physicalExam === "INVALIDATED") {
    return "AWAITING_RESUBMISSION";
  }
  if (laboratory === "FINALIZED" && physicalExam === "FINALIZED") {
    return "FULLY_SUBMITTED";
  }
  if (laboratory === "FINALIZED" || physicalExam === "FINALIZED") {
    return "PARTIALLY_SUBMITTED";
  }
  return "NOT_SUBMITTED";
}
