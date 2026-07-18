import Link from "next/link";
import { AppointmentPagination } from "@/components/appointments/AppointmentPagination";
import type { AppointmentListSort } from "@/components/appointments/appointment-list-sort";
import { Badge } from "@/components/ui/Badge";
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
  };
  appointments: ClinicAppointment[];
};

const operationalStatuses = ["PENDING", "COMPLETED", "NO_SHOW", "RESCHEDULED", "CANCELLED"];
const sortOptions: Array<[AppointmentListSort, string]> = [
  ["surname_asc", "Surname A-Z"],
  ["surname_desc", "Surname Z-A"],
  ["soonest", "Soonest"],
  ["latest", "Latest"],
];

function statusTone(status: string) {
  if (status === "COMPLETED") return "success" as const;
  if (status === "NO_SHOW" || status === "CANCELLED") return "danger" as const;
  return "warning" as const;
}

export function ClinicPublishedSchedule({
  basePath,
  title,
  description,
  emptyMessage,
  page,
  total,
  filters,
  appointments,
}: ClinicPublishedScheduleProps) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
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
              {operationalStatuses.map((status) => <option key={status}>{status}</option>)}
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
      <Card className="overflow-hidden p-0">
        {appointments.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted">{emptyMessage}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cpu-navy-soft/70">
                <tr>
                  <th className="px-5 py-3">Student</th>
                  <th className="px-5 py-3">Service</th>
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {appointments.map((appointment) => (
                  <tr key={appointment.id} className="transition hover:bg-cpu-navy-soft/35">
                    <td className="px-5 py-4">
                      <p className="font-bold text-ink">{appointment.studentName}</p>
                      <p className="font-mono text-xs text-muted">{appointment.studentNumber}</p>
                    </td>
                    <td className="px-5 py-4">{appointment.scheduleType.replaceAll("_", " ")}</td>
                    <td className="px-5 py-4">{appointment.appointmentDate}</td>
                    <td className="px-5 py-4"><Badge tone={statusTone(appointment.status)}>{appointment.status}</Badge></td>
                    <td className="px-5 py-4 text-right">
                      <Link className="font-bold text-cpu-navy hover:underline" href={`/appointments/${appointment.id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
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
