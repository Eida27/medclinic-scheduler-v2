import type {
  AdminSubmissionProgress,
  CurrentSubmissionState,
} from "@/server/student-results/admin-student-result-profile";

const progressLabels = {
  AWAITING_RESUBMISSION: "Awaiting resubmission",
  FULLY_SUBMITTED: "Fully submitted",
  PARTIALLY_SUBMITTED: "Partially submitted",
  NOT_SUBMITTED: "Not submitted",
} as const satisfies Record<AdminSubmissionProgress, string>;

const stateLabels = {
  FINALIZED: "Finalized",
  INVALIDATED: "Invalidated — awaiting resubmission",
  NOT_SUBMITTED: "Not submitted yet",
} as const satisfies Record<CurrentSubmissionState, string>;

const progressTones = {
  AWAITING_RESUBMISSION: "danger",
  FULLY_SUBMITTED: "success",
  PARTIALLY_SUBMITTED: "warning",
  NOT_SUBMITTED: "neutral",
} as const satisfies Record<
  AdminSubmissionProgress,
  "danger" | "success" | "warning" | "neutral"
>;

const resultDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

const resultSizeFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

export function submissionProgressLabel(progress: AdminSubmissionProgress) {
  return progressLabels[progress];
}

export function submissionProgressTone(progress: AdminSubmissionProgress) {
  return progressTones[progress];
}

export function currentSubmissionStateLabel(state: CurrentSubmissionState) {
  return stateLabels[state];
}

export function formatResultBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${resultSizeFormatter.format(bytes / 1024)} KB`;
  }
  return `${resultSizeFormatter.format(bytes / 1024 / 1024)} MB`;
}

export function formatResultDateTime(value: Date | string) {
  return resultDateTimeFormatter.format(new Date(value));
}
