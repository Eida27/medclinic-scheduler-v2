"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  historicalReportSorts,
  type HistoricalOverallStatusFilter,
  type HistoricalReportFilters,
  type HistoricalRequirementStatus,
} from "@/lib/historical-compliance-report";
import { operationalStatusLabel } from "@/components/appointments/status-labels";

type AcademicYearOption = { startYear: number; label: string };
type ReportDimensions = {
  colleges: Array<{ id: string; name: string }>;
  programs: Array<{ id: string; collegeId: string; code: string | null; name: string }>;
  yearLevels: number[];
};

function compareText(left: string, right: string) {
  return left.localeCompare(right, "en", { sensitivity: "base" }) || left.localeCompare(right);
}

function collegeOptions(colleges: ReportDimensions["colleges"]) {
  const namesById = new Map<string, Set<string>>();
  for (const college of colleges) {
    const names = namesById.get(college.id) ?? new Set<string>();
    names.add(college.name);
    namesById.set(college.id, names);
  }
  return [...namesById].map(([id, names]) => ({
    id,
    name: [...names].sort(compareText).join(" / "),
  })).sort((left, right) => compareText(left.name, right.name) || left.id.localeCompare(right.id));
}

function programOptions(
  dimensions: ReportDimensions,
  selectedCollegeId: string,
) {
  const available = selectedCollegeId
    ? dimensions.programs.filter((program) => program.collegeId === selectedCollegeId)
    : dimensions.programs;
  const namesByCollegeId = new Map(
    collegeOptions(dimensions.colleges).map((college) => [college.id, college.name]),
  );
  const variantsById = new Map<string, typeof available>();
  for (const program of available) {
    const variants = variantsById.get(program.id) ?? [];
    if (!variants.some((variant) => (
      variant.collegeId === program.collegeId
      && variant.code === program.code
      && variant.name === program.name
    ))) variants.push(program);
    variantsById.set(program.id, variants);
  }
  return [...variantsById].map(([id, variants]) => {
    variants.sort((left, right) => (
      compareText(namesByCollegeId.get(left.collegeId) ?? left.collegeId,
        namesByCollegeId.get(right.collegeId) ?? right.collegeId)
      || compareText(left.code ?? "", right.code ?? "")
      || compareText(left.name, right.name)
      || left.collegeId.localeCompare(right.collegeId)
    ));
    const spansColleges = new Set(variants.map((variant) => variant.collegeId)).size > 1;
    return {
      id,
      label: variants.map((variant) => {
        const programLabel = variant.code ? `${variant.code} — ${variant.name}` : variant.name;
        return spansColleges
          ? `${programLabel} (${namesByCollegeId.get(variant.collegeId) ?? variant.collegeId})`
          : programLabel;
      }).join(" / "),
    };
  }).sort((left, right) => compareText(left.label, right.label) || left.id.localeCompare(right.id));
}

const requirementStatuses: HistoricalRequirementStatus[] = [
  "UNSCHEDULED",
  "PENDING",
  "COMPLETED",
  "NO_SHOW",
  "RESCHEDULED",
  "CANCELLED",
  "AWAITING_RESCHEDULE",
];
const overallStatuses: Array<[HistoricalOverallStatusFilter, string]> = [
  ["COMPLIED", "Complied"],
  ["PENDING_COMPLIANCE", "Pending Compliance"],
  ["DID_NOT_COMPLY", "Did Not Comply"],
];
const sortLabels: Record<typeof historicalReportSorts[number], string> = {
  college_asc: "College: A-Z",
  college_desc: "College: Z-A",
  program_asc: "Program: A-Z",
  program_desc: "Program: Z-A",
  year_asc: "Year level: lowest first",
  year_desc: "Year level: highest first",
  name_asc: "Student name: A-Z",
  name_desc: "Student name: Z-A",
  attention_first: "Needs attention first",
  completed_first: "Complied students first",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm font-bold text-ink">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ReportFilters({
  years,
  filters,
  dimensions,
}: {
  years: AcademicYearOption[];
  filters: HistoricalReportFilters;
  dimensions: ReportDimensions;
}) {
  const [collegeId, setCollegeId] = useState(filters.collegeId ?? "");
  const [programId, setProgramId] = useState(filters.programId ?? "");
  const colleges = collegeOptions(dimensions.colleges);
  const programs = programOptions(dimensions, collegeId);
  const resetHref = filters.academicYearStart === null
    ? "/reports"
    : `/reports?academicYearStart=${filters.academicYearStart}`;

  return (
    <Card>
      <form
        action="/reports"
        method="get"
        aria-label="Report filters"
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
      >
        <Field label="Academic year">
          <Select name="academicYearStart" required defaultValue={filters.academicYearStart ?? ""}>
            <option value="">Select an academic year</option>
            {years.map((year) => (
              <option key={year.startYear} value={year.startYear}>{year.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Student name or number">
          <Input name="search" defaultValue={filters.search} placeholder="Search students" />
        </Field>
        <Field label="Overall compliance">
          <Select name="overallStatus" defaultValue={filters.overallStatus ?? ""}>
            <option value="">Any overall status</option>
            {overallStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
        <Field label="Laboratory status">
          <Select name="laboratoryStatus" defaultValue={filters.laboratoryStatus ?? ""}>
            <option value="">Any laboratory status</option>
            {requirementStatuses.map((status) => (
              <option key={status} value={status}>{operationalStatusLabel(status)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Physical Examination status">
          <Select name="physicalExamStatus" defaultValue={filters.physicalExamStatus ?? ""}>
            <option value="">Any physical examination status</option>
            {requirementStatuses.map((status) => (
              <option key={status} value={status}>{operationalStatusLabel(status)}</option>
            ))}
          </Select>
        </Field>
        <Field label="College">
          <Select
            name="collegeId"
            value={collegeId}
            onChange={(event) => {
              const nextCollegeId = event.target.value;
              setCollegeId(nextCollegeId);
              if (
                nextCollegeId
                && programId
                && !dimensions.programs.some((program) => (
                  program.id === programId && program.collegeId === nextCollegeId
                ))
              ) {
                setProgramId("");
              }
            }}
          >
            <option value="">Any college</option>
            {colleges.map((college) => (
              <option key={college.id} value={college.id}>{college.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Program">
          <Select name="programId" value={programId} onChange={(event) => setProgramId(event.target.value)}>
            <option value="">Any program</option>
            {programs.map((program) => (
              <option key={program.id} value={program.id}>{program.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Year level">
          <Select name="yearLevel" defaultValue={filters.yearLevel ?? ""}>
            <option value="">Any year level</option>
            {dimensions.yearLevels.map((yearLevel) => (
              <option key={yearLevel} value={yearLevel}>Year {yearLevel}</option>
            ))}
          </Select>
        </Field>
        <Field label="Sort">
          <Select name="sort" defaultValue={filters.sort}>
            {historicalReportSorts.map((sort) => <option key={sort} value={sort}>{sortLabels[sort]}</option>)}
          </Select>
        </Field>
        <div className="flex items-end gap-3 md:col-span-2">
          <Button type="submit" className="flex-1 sm:flex-none">Apply filters</Button>
          <Link
            href={resetHref}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy sm:flex-none"
          >
            Clear filters
          </Link>
        </div>
      </form>
    </Card>
  );
}
