import type { CalendarDateCell } from "../clinic-calendar";
import type { CalendarDateState } from "../clinic-calendar-draft";

type ClinicCalendarDayProps = {
  cell: CalendarDateCell;
  state: CalendarDateState;
  disabled: boolean;
  nonSchedulingDay?: boolean;
  highlighted?: boolean;
  onToggle(date: string): void;
};

const categoryLabels = {
  HOLIDAY: "Holiday",
  CLOSURE: "Closure",
  MAINTENANCE: "Maintenance",
  STAFF_UNAVAILABILITY: "Staff unavailability",
} as const;

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function describeState(state: CalendarDateState) {
  switch (state.state) {
    case "SAVED_BLOCKED":
      return {
        label: `blocked: ${categoryLabels[state.record.category]}, ${state.record.reason}`,
        text: "Blocked",
        className: "border-red-300 bg-red-50 text-red-900",
      };
    case "STAGED_BLOCK":
      return {
        label: `will be blocked: ${categoryLabels[state.change.category]}`,
        text: "Will be blocked",
        className: "border-amber-300 bg-amber-50 text-amber-950",
      };
    case "STAGED_UNBLOCK":
      return {
        label: "will be reopened",
        text: "Will be reopened",
        className: "border-emerald-300 bg-emerald-50 text-emerald-950",
      };
    case "CONFLICT":
      return {
        label: `conflict: ${state.messages.join(", ")}`,
        text: "Needs review",
        className: "border-red-500 bg-red-50 text-red-900",
      };
    default:
      return {
        label: "available",
        text: "Available",
        className: "border-line bg-surface text-ink",
      };
  }
}

export function ClinicCalendarDay({
  cell,
  state,
  disabled,
  nonSchedulingDay = false,
  highlighted = false,
  onToggle,
}: ClinicCalendarDayProps) {
  const description = nonSchedulingDay
    ? {
        label: "non-scheduling day",
        text: "Non-scheduling day",
        className: "border-line bg-canvas text-muted",
      }
    : describeState(state);
  const dateLabel = formatDate(cell.date);

  return (
    <button
      type="button"
      disabled={disabled}
      data-highlighted={highlighted ? true : undefined}
      aria-label={`${dateLabel} — ${description.label}`}
      onClick={() => onToggle(cell.date)}
      className={`flex min-h-20 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${highlighted ? "ring-2 ring-cpu-gold ring-offset-2" : ""} ${description.className}`}
    >
      <span>{cell.dayOfMonth}</span>
      <span className="text-[0.65rem] font-bold uppercase tracking-wide">{description.text}</span>
    </button>
  );
}
