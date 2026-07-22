type StatusTone = "success" | "danger" | "warning" | "neutral";

const appointmentResultStatusLabels: Record<string, string> = {
  PENDING_UPLOAD: "Pending",
  COMPLETED: "Completed",
  REQUIRES_FOLLOW_UP: "Needs follow-up",
  NOT_APPLICABLE: "Not applicable",
};

const overallStatusLabels: Record<string, string> = {
  COMPLETE: "Complete",
  INCOMPLETE: "Incomplete",
  FOLLOW_UP: "Needs follow-up",
};

const operationalStatusLabels: Record<string, string> = {
  PENDING: "Pending",
  COMPLETED: "Completed",
  NO_SHOW: "No-show",
  RESCHEDULED: "Rescheduled",
  CANCELLED: "Cancelled",
};

function readableStatus(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function appointmentResultStatusLabel(value: string): string {
  return appointmentResultStatusLabels[value] ?? readableStatus(value);
}

export function overallStatusLabel(value: string): string {
  return overallStatusLabels[value] ?? readableStatus(value);
}

export function operationalStatusLabel(value: string): string {
  return operationalStatusLabels[value] ?? readableStatus(value);
}

export function statusTone(value: string): StatusTone {
  if (value === "COMPLETED" || value === "COMPLETE") return "success";
  if (value === "NO_SHOW" || value === "CANCELLED") return "danger";
  if (
    value === "REQUIRES_FOLLOW_UP" ||
    value === "FOLLOW_UP" ||
    value === "PENDING" ||
    value === "RESCHEDULED"
  ) {
    return "warning";
  }
  return "neutral";
}
