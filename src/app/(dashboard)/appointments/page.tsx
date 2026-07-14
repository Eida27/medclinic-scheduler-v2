import Link from "next/link";
import { AppointmentPagination } from "@/components/appointments/AppointmentPagination";
import {
  parseAppointmentSummarySort,
  type OverallStatus,
} from "@/components/appointments/appointment-summary";
import {
  APPOINTMENT_PAGE_SIZE,
  parseAppointmentPage,
} from "@/components/appointments/appointment-pagination";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import {
  appointmentSummaryReport,
  type AppointmentSummaryItem,
} from "@/server/repositories/appointment-summary.repository";
import {
  listColleges,
  listPriorityGroups,
  listPrograms,
} from "@/server/repositories/reference-data.repository";

type AppointmentsSearchParams = Record<string, string | undefined>;

const appointmentStatuses = ["PENDING", "COMPLETED", "NO_SHOW"];
const resultStatuses = ["PENDING", "COMPLETED", "REQUIRES_FOLLOW_UP", "NOT_APPLICABLE"];
const overallStatuses: OverallStatus[] = ["FOLLOW_UP", "INCOMPLETE", "COMPLETE"];
const sortOptions = [
  ["upcoming_asc", "Upcoming schedule: soonest first"],
  ["upcoming_desc", "Upcoming schedule: latest first"],
  ["name_asc", "Student name: A-Z"],
  ["name_desc", "Student name: Z-A"],
  ["attention_first", "Needs attention first"],
  ["completed_first", "Fully completed first"],
] as const;

function isOverallStatus(value?: string): value is OverallStatus {
  return overallStatuses.includes(value as OverallStatus);
}

function statusTone(value: string | null) {
  if (value === "COMPLETED" || value === "COMPLETE") return "success" as const;
  if (value === "NO_SHOW") return "danger" as const;
  if (value === "REQUIRES_FOLLOW_UP" || value === "FOLLOW_UP") return "warning" as const;
  return "neutral" as const;
}

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<AppointmentsSearchParams>;
}) {
  const params = await searchParams;
  const page = parseAppointmentPage(params.page);
  const sort = parseAppointmentSummarySort(params.sort);
  const appointmentStatus = params.appointmentStatus ?? params.status;
  const overallStatus = isOverallStatus(params.overallStatus) ? params.overallStatus : undefined;
  const filters = {
    studentNumber: params.studentNumber,
    appointmentDate: params.appointmentDate,
    appointmentStatus,
    collegeId: params.collegeId,
    programId: params.programId,
    priorityGroupId: params.priorityGroupId,
    physicalExamStatus: params.physicalExamStatus,
    laboratoryStatus: params.laboratoryStatus,
    overallStatus,
    sort,
  };
  const hasAdvancedFilters = Boolean(
    params.appointmentDate
      || appointmentStatus
      || params.collegeId
      || params.programId
      || params.priorityGroupId
      || params.physicalExamStatus
      || params.laboratoryStatus,
  );
  const [report, colleges, programs, priorities] = await Promise.all([
    appointmentSummaryReport({
      search: params.studentNumber,
      appointmentDate: params.appointmentDate,
      appointmentStatus,
      collegeId: params.collegeId,
      programId: params.programId,
      priorityGroupId: params.priorityGroupId,
      physicalExamStatus: params.physicalExamStatus,
      laboratoryStatus: params.laboratoryStatus,
      overallStatus,
      sort,
      page,
      limit: APPOINTMENT_PAGE_SIZE,
      offset: (page - 1) * APPOINTMENT_PAGE_SIZE,
    }),
    listColleges(),
    listPrograms(),
    listPriorityGroups(),
  ]);
  const singular = report.total === 1;
  const metrics = [
    ["Matching students", report.summary.totalStudents],
    ["Physical completed", report.summary.physicalCompleted],
    ["Laboratory completed", report.summary.laboratoryCompleted],
    ["Incomplete any", report.summary.pendingAny],
  ];

  return (
    <>
      <PageHeader
        title="Appointments & Completion"
        description={`${report.total} active student${singular ? "" : "s"} ${singular ? "matches" : "match"} the current filters.`}
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value]) => (
          <Card key={label} className="relative overflow-hidden">
            <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-cpu-gold" />
            <p className="text-sm font-semibold text-muted">{label}</p>
            <p className="mt-2 text-3xl font-black tracking-tight text-ink">{value}</p>
          </Card>
        ))}
      </section>
      <Card>
        <form className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-4">
            <label className="grid gap-1.5 text-sm font-bold text-ink">
              <span>Student name or number</span>
              <Input
                name="studentNumber"
                defaultValue={params.studentNumber}
                placeholder="Search by name or student number"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-ink">
              <span>Overall status</span>
              <Select name="overallStatus" defaultValue={overallStatus}>
                <option value="">Any overall status</option>
                {overallStatuses.map((status) => <option key={status}>{status}</option>)}
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold text-ink">
              <span>Sort</span>
              <Select name="sort" defaultValue={sort}>
                {sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </label>
            <button
              className="mt-auto h-11 rounded-xl border border-line bg-surface font-bold text-ink transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
              type="submit"
            >
              Apply filters
            </button>
          </div>
          <details open={hasAdvancedFilters} className="rounded-xl border border-line bg-canvas/45 p-4">
            <summary className="cursor-pointer font-bold text-ink">More filters</summary>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="grid gap-1.5 text-sm font-bold text-ink">
                <span>Appointment date</span>
                <Input name="appointmentDate" type="date" defaultValue={params.appointmentDate} />
              </label>
              <label className="grid gap-1.5 text-sm font-bold text-ink">
                <span>Appointment status</span>
                <Select name="appointmentStatus" defaultValue={appointmentStatus}>
                  <option value="">Any appointment status</option>
                  {appointmentStatuses.map((status) => <option key={status}>{status}</option>)}
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold text-ink">
                <span>College</span>
                <Select name="collegeId" defaultValue={params.collegeId}>
                  <option value="">All colleges</option>
                  {colleges.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold text-ink">
                <span>Program</span>
                <Select name="programId" defaultValue={params.programId}>
                  <option value="">All programs</option>
                  {programs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold text-ink">
                <span>Priority</span>
                <Select name="priorityGroupId" defaultValue={params.priorityGroupId}>
                  <option value="">All priorities</option>
                  {priorities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold text-ink">
                <span>Physical result</span>
                <Select name="physicalExamStatus" defaultValue={params.physicalExamStatus}>
                  <option value="">Any physical result</option>
                  {resultStatuses.map((status) => <option key={status}>{status}</option>)}
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold text-ink">
                <span>Laboratory result</span>
                <Select name="laboratoryStatus" defaultValue={params.laboratoryStatus}>
                  <option value="">Any laboratory result</option>
                  {resultStatuses.map((status) => <option key={status}>{status}</option>)}
                </Select>
              </label>
              <Link className="mt-auto flex h-11 items-center justify-center rounded-xl border border-line bg-surface text-sm font-bold text-ink hover:bg-cpu-navy-soft" href="/appointments">
                Clear filters
              </Link>
            </div>
          </details>
        </form>
      </Card>
      <Card className="overflow-hidden p-0">
        {report.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted">No students match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cpu-navy-soft/70">
                <tr>
                  <th className="px-5 py-3">Student</th>
                  <th className="px-5 py-3">Laboratory</th>
                  <th className="px-5 py-3">Physical exam</th>
                  <th className="px-5 py-3">Overall</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(report.items as AppointmentSummaryItem[]).map((item) => (
                  <tr key={item.studentNumber} className="align-top transition hover:bg-cpu-navy-soft/35">
                    <td className="px-5 py-4">
                      <Link className="font-bold text-cpu-navy hover:underline" href={`/students/${encodeURIComponent(item.studentNumber)}`}>
                        {item.studentName}
                      </Link>
                      <p className="font-mono text-xs text-muted">{item.studentNumber}</p>
                      <p className="mt-1 text-xs text-muted">{item.programName}</p>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={statusTone(item.laboratoryStatus)}>{item.laboratoryStatus}</Badge>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={statusTone(item.physicalExamStatus)}>{item.physicalExamStatus}</Badge>
                    </td>
                    <td className="px-5 py-4"><Badge tone={statusTone(item.overallStatus)}>{item.overallStatus}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AppointmentPagination
          basePath="/appointments"
          page={page}
          total={report.total}
          filters={filters}
        />
      </Card>
    </>
  );
}
