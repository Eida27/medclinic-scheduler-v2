import type { CalendarCell, CalendarDateCell } from "../clinic-calendar";
import type { CalendarDateState } from "../clinic-calendar-draft";
import { ClinicCalendarDay } from "./ClinicCalendarDay";

type ClinicMonthGridProps = {
  cells: CalendarCell[];
  getState(cell: CalendarDateCell): CalendarDateState;
  today: string;
  disabled: boolean;
  highlightedDates?: ReadonlySet<string>;
  onToggle(date: string): void;
};

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function ClinicMonthGrid({ cells, getState, today, disabled, highlightedDates, onToggle }: ClinicMonthGridProps) {
  return (
    <section aria-label="Clinic availability calendar" className="min-w-[42rem]">
      <div className="grid grid-cols-7 gap-1">
        {weekdays.map((weekday) => <div key={weekday} className="px-2 py-1 text-center text-xs font-bold text-muted">{weekday}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((cell) => {
          if (cell.kind === "blank") {
            return <div key={cell.key} aria-hidden="true" data-testid="calendar-blank-cell" data-outside-month="true" className="min-h-20 rounded-xl border border-transparent bg-canvas/40" />;
          }

          return (
            <ClinicCalendarDay
              key={cell.key}
              cell={cell}
              state={getState(cell)}
              disabled={disabled || cell.date <= today || cell.isWeekend}
              nonSchedulingDay={cell.isWeekend}
              highlighted={highlightedDates?.has(cell.date)}
              onToggle={onToggle}
            />
          );
        })}
      </div>
    </section>
  );
}
