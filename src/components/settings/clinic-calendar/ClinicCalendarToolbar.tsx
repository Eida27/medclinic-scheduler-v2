"use client";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { shiftMonth } from "../clinic-calendar";

type ClinicCalendarToolbarProps = {
  clinics: Array<{ id: string; name: string }>;
  selectedClinicId: string;
  month: string;
  currentYear: number;
  maxYear: number;
  disabled: boolean;
  onClinicChange(clinicId: string): void;
  onMonthChange(month: string): void;
};

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function splitMonth(month: string) {
  const [year, monthNumber] = month.split("-");
  return { year: Number(year), monthIndex: Number(monthNumber) - 1 };
}

export function ClinicCalendarToolbar({
  clinics,
  selectedClinicId,
  month,
  currentYear,
  maxYear,
  disabled,
  onClinicChange,
  onMonthChange,
}: ClinicCalendarToolbarProps) {
  const { year, monthIndex } = splitMonth(month);
  const atEarliestMonth = month === `${currentYear}-01`;
  const atLatestMonth = month === `${maxYear}-12`;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(9rem,.7fr)_minmax(9rem,.8fr)_auto_auto]">
      <Field label="Clinic">
        <Select value={selectedClinicId} disabled={disabled} onChange={(event) => onClinicChange(event.target.value)}>
          {clinics.map((clinic) => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
        </Select>
      </Field>
      <Field label="Month">
        <Select
          value={String(monthIndex + 1)}
          disabled={disabled}
          onChange={(event) => onMonthChange(`${year}-${event.target.value.padStart(2, "0")}`)}
        >
          {monthNames.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
        </Select>
      </Field>
      <Field label="Year">
        <Select
          value={String(year)}
          disabled={disabled}
          onChange={(event) => onMonthChange(`${event.target.value}-${String(monthIndex + 1).padStart(2, "0")}`)}
        >
          {Array.from({ length: maxYear - currentYear + 1 }, (_, index) => currentYear + index)
            .map((optionYear) => <option key={optionYear} value={optionYear}>{optionYear}</option>)}
        </Select>
      </Field>
      <Button
        variant="secondary"
        size="sm"
        aria-label="Previous month"
        disabled={disabled || atEarliestMonth}
        onClick={() => onMonthChange(shiftMonth(month, -1))}
      >
        Previous
      </Button>
      <Button
        variant="secondary"
        size="sm"
        aria-label="Next month"
        disabled={disabled || atLatestMonth}
        onClick={() => onMonthChange(shiftMonth(month, 1))}
      >
        Next
      </Button>
    </div>
  );
}
