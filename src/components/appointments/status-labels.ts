type StatusTone = "success" | "danger" | "warning" | "neutral";

const operationalStatusLabels: Record<string, string> = {
  UNSCHEDULED: "Unscheduled",
  PENDING: "Pending",
  COMPLETED: "Completed",
  NO_SHOW: "No-show",
  RESCHEDULED: "Rescheduled",
  CANCELLED: "Cancelled",
  AWAITING_RESCHEDULE: "Awaiting manual reschedule",
};

function readableStatus(value: string): string {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
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
    || value === "AWAITING_RESCHEDULE"
  ) {
    return "warning";
  }
  return "neutral";
}
