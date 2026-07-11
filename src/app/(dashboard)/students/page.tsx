import Link from "next/link";
import { ScheduleImportHistoryTable } from "@/components/schedules/ScheduleImportHistoryTable";
import { StudentsSchedulesTabs } from "@/components/students/StudentsSchedulesTabs";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { requireUser } from "@/server/auth/current-user";
import { listColleges, listPrograms } from "@/server/repositories/reference-data.repository";
import { listScheduleImports } from "@/server/services/schedule-imports.service";
import { listStudents } from "@/server/services/students.service";

const pageSize = 20;

type StudentsSearchParams = Record<string, string | undefined>;

function studentPageHref(params: StudentsSearchParams, page: number) {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.collegeId) query.set("collegeId", params.collegeId);
  if (params.programId) query.set("programId", params.programId);
  if (params.yearLevel) query.set("yearLevel", params.yearLevel);
  query.set("page", String(page));
  return `/students?${query.toString()}`;
}

function HeaderActions({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {isAdmin ? (
        <>
          <Link
            href="/students/schedule-imports/new"
            className="rounded-xl bg-cpu-navy px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-cpu-navy-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
          >
            Import schedule CSV
          </Link>
          <Link
            href="/templates/student-schedule-import-template.csv"
            download
            className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-bold text-ink transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
          >
            Download CSV template
          </Link>
        </>
      ) : null}
      <Link
        href="/students/new"
        className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-bold text-ink transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
      >
        Add student
      </Link>
    </div>
  );
}

function StudentsView({
  params,
  students,
  colleges,
  programs,
}: {
  params: StudentsSearchParams;
  students: Awaited<ReturnType<typeof listStudents>>;
  colleges: Awaited<ReturnType<typeof listColleges>>;
  programs: Awaited<ReturnType<typeof listPrograms>>;
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const totalPages = Math.max(1, Math.ceil(students.total / pageSize));

  return (
    <>
      <Card>
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Input
            aria-label="Search students"
            name="search"
            defaultValue={params.search}
            placeholder="Student number or name"
            className="xl:col-span-2"
          />
          <Select aria-label="College" name="collegeId" defaultValue={params.collegeId}>
            <option value="">All colleges</option>
            {colleges.map((college) => (
              <option key={college.id} value={college.id}>{college.name}</option>
            ))}
          </Select>
          <Select aria-label="Program" name="programId" defaultValue={params.programId}>
            <option value="">All programs</option>
            {programs.map((program) => (
              <option key={program.id} value={program.id}>{program.name}</option>
            ))}
          </Select>
          <Select aria-label="Year level" name="yearLevel" defaultValue={params.yearLevel}>
            <option value="">All year levels</option>
            {[1, 2, 3, 4, 5, 6].map((year) => (
              <option key={year} value={year}>Year {year}</option>
            ))}
          </Select>
          <button className="h-11 rounded-xl border border-line bg-surface text-sm font-bold text-ink transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy">
            Apply filters
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cpu-navy-soft/70 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-3">Student</th>
                <th className="px-5 py-3">Program</th>
                <th className="px-5 py-3">Year / section</th>
                <th className="px-5 py-3"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {students.items.map((student) => (
                <tr key={student.studentNumber} className="transition hover:bg-cpu-navy-soft/35">
                  <td className="px-5 py-4">
                    <p className="font-bold text-ink">{student.fullName}</p>
                    <p className="font-mono text-xs text-muted">{student.studentNumber}</p>
                  </td>
                  <td className="px-5 py-4">
                    <p>{student.programName}</p>
                    <p className="text-xs text-muted">{student.collegeName}</p>
                  </td>
                  <td className="px-5 py-4">
                    {student.yearLevel ? `Year ${student.yearLevel}` : "-"}
                    {student.section ? ` / ${student.section}` : ""}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <Link
                      className="font-bold text-cpu-navy hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
                      href={`/students/${encodeURIComponent(student.studentNumber)}`}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {students.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted">No active students match these filters.</p>
        ) : null}
        {students.total > 0 ? (
          <nav
            aria-label="Student pagination"
            className="flex items-center justify-between border-t border-line px-5 py-4 text-sm"
          >
            {page > 1 ? (
              <Link
                aria-label="Previous page"
                href={studentPageHref(params, page - 1)}
                className="font-bold text-cpu-navy hover:underline"
              >
                Previous
              </Link>
            ) : <span />}
            <span className="text-muted">Page {page} of {totalPages}</span>
            {page < totalPages ? (
              <Link
                aria-label="Next page"
                href={studentPageHref(params, page + 1)}
                className="font-bold text-cpu-navy hover:underline"
              >
                Next
              </Link>
            ) : <span />}
          </nav>
        ) : null}
      </Card>
    </>
  );
}

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<StudentsSearchParams>;
}) {
  const [params, user] = await Promise.all([searchParams, requireUser()]);
  const isAdmin = user.role === "ADMIN";
  const activeView = isAdmin && params.view === "schedule-imports"
    ? "schedule-imports"
    : "students";
  let content;
  if (activeView === "schedule-imports") {
    content = <ScheduleImportHistoryTable imports={await listScheduleImports(user)} />;
  } else {
    const page = Math.max(1, Number(params.page) || 1);
    const [students, colleges, programs] = await Promise.all([
      listStudents({
        search: params.search,
        collegeId: params.collegeId,
        programId: params.programId,
        yearLevel: Number(params.yearLevel) || undefined,
        page,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      listColleges(),
      listPrograms(),
    ]);
    content = (
      <StudentsView
        params={params}
        students={students}
        colleges={colleges}
        programs={programs}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Students & Schedules"
        description="Manage student records and publish imported clinic schedules."
        actions={<HeaderActions isAdmin={isAdmin} />}
      />
      <StudentsSchedulesTabs activeView={activeView} isAdmin={isAdmin} />
      {content}
    </>
  );
}
