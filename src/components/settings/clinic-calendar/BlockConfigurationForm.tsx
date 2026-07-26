"use client";

import { useEffect, useState } from "react";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import type { ClinicCalendarCategory } from "@/types/clinic-calendar";

type BlockConfiguration = {
  category: ClinicCalendarCategory;
  reason: string;
  valid: boolean;
};

type BlockConfigurationFormProps = {
  disabled: boolean;
  onChange(configuration: BlockConfiguration): void;
};

const categories: Array<{ value: ClinicCalendarCategory; label: string }> = [
  { value: "HOLIDAY", label: "Holiday" },
  { value: "CLOSURE", label: "Closure" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "STAFF_UNAVAILABILITY", label: "Staff unavailability" },
];

export function BlockConfigurationForm({ disabled, onChange }: BlockConfigurationFormProps) {
  const [category, setCategory] = useState<ClinicCalendarCategory>("CLOSURE");
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();
  const valid = trimmedReason.length >= 3 && trimmedReason.length <= 500;

  useEffect(() => {
    onChange({ category, reason: trimmedReason, valid });
  }, [category, onChange, trimmedReason, valid]);

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(12rem,.6fr)_minmax(0,1.4fr)]">
      <Field label="Category">
        <Select value={category} disabled={disabled} onChange={(event) => setCategory(event.target.value as ClinicCalendarCategory)}>
          {categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
      <Field label="Reason">
        <Textarea
          value={reason}
          disabled={disabled}
          minLength={3}
          maxLength={500}
          required
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </div>
  );
}
