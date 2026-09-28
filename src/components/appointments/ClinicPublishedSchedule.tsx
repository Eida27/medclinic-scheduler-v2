"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppointmentPagination } from "@/components/appointments/AppointmentPagination";
import { BulkReplacementDialog, type SelectedReplacement } from "@/components/appointments/BulkReplacementDialog";
import { PhysicalExamCompletionDialog } from "@/components/appointments/PhysicalExamCompletionDialog";
import { CertificateDownload } from "@/components/medical-certificates/CertificateDownload";
import { LaboratoryChecklist } from "@/components/appointments/LaboratoryChecklist";
import type { AppointmentListSort } from "@/components/appointments/appointment-list-sort";
import { operationalStatusLabel } from "@/components/appointments/status-labels";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";

type ClinicAppointment = {
  id: string;
  studentNumber: string;
  studentName: string;
  scheduleType: string;
  appointmentDate: string;
  status: string;
  isManuallyLocked: boolean;
  completedFromStatus: "PENDING" | "NO_SHOW" | null;
  laboratoryStatus?: "PENDING" | "COMPLETED" | "NO_SHOW" | null;
  laboratoryVerifiedTests?: number | null;
  laboratoryRequiredTests?: number | null;
  locationName?: string;
  isOvpsaFirstYear?: boolean;
  displayStatus?: string;
  academicYearEnded?: boolean;
  updatedAt?: Date | string;
};

type ClinicPublishedScheduleProps = {
  basePath: string;
  title: string;
  description: string;
  emptyMessage: string;
  page: number;
  total: number;
  filters: {
    studentNumber?: string;
    appointmentDate?: string;
    status?: string;
    sort?: AppointmentListSort;
    academicYearStart?: string;
  };
  appointments: ClinicAppointment[];
  showLaboratoryStatus?: boolean;
  canBulkReplace?: boolean;
  canCompletePhysicalExam?: boolean;
};

function laboratoryStatusBadge(status: ClinicAppointment["laboratoryStatus"]) {
  if (status === "PENDING") return { label: "Pending", className: "bg-slate-100 text-slate-800" };
  if (status === "COMPLETED") return { label: "Completed", className: "bg-emerald-100 text-emerald-800" };
  if (status === "NO_SHOW") return { label: "No-show", className: "bg-red-100 text-red-800" };
  return { label: "Not available", className: "bg-slate-100 text-muted" };
}

const operationalStatuses = ["PENDING", "COMPLETED", "NO_SHOW"];
const physicalCompletionBlockReason =
  "Laboratory must be completed before Physical Examination can be marked completed.";
const sortOptions: Array<[AppointmentListSort, string]> = [
  ["surname_asc", "Surname A-Z"],
  ["surname_desc", "Surname Z-A"],
  ["soonest", "Soonest"],
  ["latest", "Latest"],
];

export function ClinicPublishedSchedule({
  basePath,
  title,
  description,
  emptyMessage,
  page,
  total,
  filters,
  appointments,
  showLaboratoryStatus = false,
  canBulkReplace = false,
  canCompletePhysicalExam = false,
}: ClinicPublishedScheduleProps) {
  const [completionId, setCompletionId] = useState<string>();
  const [completion, setCompletion] = useState<{ certificateId: string; classification: string }>();
  const filterKey = useMemo(() => JSON.stringify({ basePath, studentNumber: filters.studentNumber,
    appointmentDate: filters.appointmentDate, status: filters.status,
    academicYearStart: filters.academicYearStart }), [basePath, filters.studentNumber,
      filters.appointmentDate, filters.status, filters.academicYearStart]);
  const selectionStorageKey = `bulk-replacements:${basePath}`;
  const [selection, setSelection] = useState<{
    filterKey: string; rows: Record<string, SelectedReplacement>;
  }>({ filterKey, rows: {} });
  const selected = selection.filterKey === filterKey ? selection.rows : {};
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const saved = sessionStorage.getItem(selectionStorageKey);
        const parsed = saved ? JSON.parse(saved) as { filterKey: string;
          rows: Record<string, SelectedReplacement> } : null;
        const next = parsed?.filterKey === filterKey && parsed.rows
          ? parsed : { filterKey, rows: {} };
        setSelection(next);
        if (parsed?.filterKey !== filterKey) {
          sessionStorage.setItem(selectionStorageKey, JSON.stringify(next));
        }
      } catch { setSelection({ filterKey, rows: {} }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [filterKey, selectionStorageKey]);
  function updateSelection(next: Record<string, SelectedReplacement>) {
    const value = { filterKey, rows: next };
    setSelection(value);
    try { sessionStorage.setItem(selectionStorageKey, JSON.stringify(value)); } catch { /* private browsing */ }
  }
  const eligible = appointments.filter((item) => canBulkReplace
    && ["PENDING", "NO_SHOW"].includes(item.status) && !item.isOvpsaFirstYear
    && !item.academicYearEnded && item.updatedAt);
  const selectedRows = Object.values(selected);
  return (
    <>
      <PageHeader title={title} description={description} />
      {completion ? <div role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 font-semibold">
        Physical Examination completed — Class {completion.classification}.{" "}
        <CertificateDownload certificateId={completion.certificateId} audience="staff" />
      </div> : null}
      {completionId ? <PhysicalExamCompletionDialog key={completionId} appointmentId={completionId}
        onClose={() => setCompletionId(undefined)}
        onCompleted={(issue, classification) => setCompletion({ certificateId: issue.certificateId, classification })} /> : null}
      <Card>
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <label className="grid gap-1.5 text-sm font-bold text-ink">
            <span>Academic year (blank for current)</span>
            <Input name="academicYearStart" type="number" min="1900" max="9999" defaultValue={filters.academicYearStart} placeholder="Current" />
          </label>
          <label className="grid gap-1.5 text-sm font-bold text-ink">
            <span>Student name or number</span>
            <Input
              name="studentNumber"
              defaultValue={filters.studentNumber}
              placeholder="Search by name or student number"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-bold text-ink">
            <span>Appointment date</span>
            <Input name="appointmentDate" type="date" defaultValue={filters.appointmentDate} />
          </label>
          <label className="grid gap-1.5 text-sm font-bold text-ink">
            <span>Status</span>
            <Select name="status" defaultValue={filters.status}>
              <option value="">All operational statuses</option>
              {operationalStatuses.map((status) => (
                <option key={status} value={status}>{operationalStatusLabel(status)}</option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm font-bold text-ink">
            <span>Sort</span>
            <Select name="sort" defaultValue={filters.sort ?? "soonest"}>
              {sortOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </label>
          <button
            className="mt-auto h-11 rounded-xl border border-line bg-surface font-bold text-ink transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
            type="submit"
          >
            Filter
          </button>
        </form>
      </Card>
      {filters.academicYearStart ? <p className="text-sm font-semibold text-muted">Academic year {filters.academicYearStart}–{Number(filters.academicYearStart) + 1} · historical records may be shown.</p> : null}
      {canBulkReplace ? <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="rounded-xl border border-line px-4 py-2 text-sm font-semibold"
            onClick={() => {
              const next = { ...selected };
              for (const item of eligible) {
                if (Object.keys(next).length >= 100) break;
                next[item.id] = { id: item.id, expectedUpdatedAt: new Date(item.updatedAt!).toISOString() };
              }
              updateSelection(next);
            }}>Select eligible on this page</button>
          <button type="button" className="text-sm font-semibold text-cpu-navy underline"
            onClick={() => updateSelection({})}>Clear selection</button>
          <span className="text-sm text-muted">{selectedRows.length} selected (maximum 100)</span>
        </div>
        {selectedRows.length ? <BulkReplacementDialog key={JSON.stringify(selectedRows)} selected={selectedRows}
          onRemove={(id) => { const next = { ...selected }; delete next[id]; updateSelection(next); }}
          onDone={() => updateSelection({})} /> : null}
      </Card> : null}
      <Card className="overflow-hidden p-0">
        {appointments.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted">{emptyMessage}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cpu-navy-soft/70">
                <tr>
                  {canBulkReplace ? <th className="px-3 py-3">Select</th> : null}
                  <th className="px-5 py-3">Student</th>
                  <th className="px-5 py-3">Service</th>
                  <th className="px-5 py-3">Date</th>
                  {showLaboratoryStatus ? <th className="px-5 py-3">Laboratory Status</th> : null}
                  <th className="px-5 py-3">
                    {showLaboratoryStatus ? "Physical Exam Status" : "Status"}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {appointments.map((appointment) => {
                  const laboratoryStatus = laboratoryStatusBadge(appointment.laboratoryStatus);
                  return (
                    <tr key={appointment.id} className="transition hover:bg-cpu-navy-soft/35">
                    {canBulkReplace ? <td className="px-3 py-4">
                      <input type="checkbox" aria-label={`Select ${appointment.studentName} for replacement`}
                        checked={Boolean(selected[appointment.id])}
                        disabled={!eligible.some((item) => item.id === appointment.id) || (!selected[appointment.id] && selectedRows.length >= 100)}
                        title={appointment.academicYearEnded ? "Academic year ended" : appointment.isOvpsaFirstYear
                          ? "Use OVPSA batch reschedule" : !["PENDING", "NO_SHOW"].includes(appointment.status)
                            ? "This appointment cannot be replaced" : undefined}
                        onChange={(event) => {
                          const next = { ...selected };
                          if (event.target.checked) next[appointment.id] = { id: appointment.id,
                            expectedUpdatedAt: new Date(appointment.updatedAt!).toISOString() };
                          else delete next[appointment.id];
                          updateSelection(next);
                        }} />
                    </td> : null}
                    <td className="px-5 py-4">
                      <Link
                        className="block font-bold text-cpu-navy hover:underline"
                        href={`${basePath}/${appointment.id}`}
                      >
                        {appointment.studentName}
                      </Link>
                      <Link
                        className="mt-1 block w-fit font-mono text-xs text-muted hover:text-cpu-navy hover:underline"
                        href={`${basePath}/${appointment.id}`}
                      >
                        {appointment.studentNumber}
                      </Link>
                    </td>
                    <td className="px-5 py-4">{appointment.scheduleType.replaceAll("_", " ")}<br/><span className="text-xs text-muted">{appointment.locationName}</span></td>
                    <td className="px-5 py-4">{appointment.appointmentDate}</td>
                    {showLaboratoryStatus ? (
                      <td className="px-5 py-4">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${laboratoryStatus.className}`}>
                          {laboratoryStatus.label}
                        </span>
                        {appointment.laboratoryRequiredTests ? <p className="mt-1 text-xs text-muted">
                          {appointment.laboratoryVerifiedTests ?? 0}/{appointment.laboratoryRequiredTests} verified
                        </p> : null}
                      </td>
                    ) : null}
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        {appointment.isOvpsaFirstYear && appointment.scheduleType === "LABORATORY" ? (
                          <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950">
                            {appointment.displayStatus ?? operationalStatusLabel(appointment.status)}
                          </span>
                        ) : appointment.scheduleType === "LABORATORY" ? (
                          <LaboratoryChecklist appointmentId={appointment.id} compact />
                        ) : (
                          <>
                            <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800">
                              {operationalStatusLabel(appointment.status)}
                            </span>
                            {appointment.status !== "COMPLETED" && !appointment.academicYearEnded ? (
                              appointment.laboratoryStatus !== "COMPLETED" ?
                                <span className="text-xs text-muted">{physicalCompletionBlockReason}</span>
                              : canCompletePhysicalExam ? (
                                <button type="button" className="text-xs font-semibold text-cpu-navy underline"
                                  onClick={() => setCompletionId(appointment.id)}>Complete Physical Examination</button>
                              ) : null
                            ) : null}
                          </>
                        )}
                        {appointment.isManuallyLocked ? (
                          <span
                            aria-label="Appointment manually locked"
                            className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-950"
                          >
                            Protected
                          </span>
                        ) : null}
                      </div>
                    </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <AppointmentPagination
          basePath={basePath}
          page={page}
          total={total}
          filters={filters}
        />
      </Card>
    </>
  );
}
