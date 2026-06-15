import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { listColleges, listPrograms } from "@/server/repositories/reference-data.repository";
import { listStudents } from "@/server/services/students.service";

export default async function StudentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const [students, colleges, programs] = await Promise.all([
    listStudents({ search: params.search, collegeId: params.collegeId, programId: params.programId, yearLevel: Number(params.yearLevel) || undefined, page, limit: 20, offset: (page - 1) * 20 }),
    listColleges(), listPrograms(),
  ]);
  return (
    <>
      <PageHeader title="Students" description={`${students.total} active student records`} actions={<Link href="/students/new" className="rounded-xl bg-cpu-navy px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-cpu-navy-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy">Add student</Link>} />
      <Card>
        <form className="grid gap-3 md:grid-cols-5">
          <Input name="search" defaultValue={params.search} placeholder="Student number or name" className="md:col-span-2" />
          <Select name="collegeId" defaultValue={params.collegeId}><option value="">All colleges</option>{colleges.map((college) => <option key={college.id} value={college.id}>{college.name}</option>)}</Select>
          <Select name="programId" defaultValue={params.programId}><option value="">All programs</option>{programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}</Select>
          <button className="h-11 rounded-xl border border-line bg-surface text-sm font-bold text-ink transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy">Apply filters</button>
        </form>
      </Card>
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-cpu-navy-soft/70 text-xs uppercase tracking-wide text-muted"><tr><th className="px-5 py-3">Student</th><th className="px-5 py-3">Program</th><th className="px-5 py-3">Year / section</th><th className="px-5 py-3"></th></tr></thead><tbody className="divide-y divide-line">{students.items.map((student) => <tr key={student.studentNumber} className="transition hover:bg-cpu-navy-soft/35"><td className="px-5 py-4"><p className="font-bold text-ink">{student.fullName}</p><p className="font-mono text-xs text-muted">{student.studentNumber}</p></td><td className="px-5 py-4"><p>{student.programName}</p><p className="text-xs text-muted">{student.collegeName}</p></td><td className="px-5 py-4">{student.yearLevel ? `Year ${student.yearLevel}` : "-"}{student.section ? ` / ${student.section}` : ""}</td><td className="px-5 py-4 text-right"><Link className="font-bold text-cpu-navy hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy" href={`/students/${encodeURIComponent(student.studentNumber)}`}>View</Link></td></tr>)}</tbody></table></div>
        {students.items.length === 0 ? <p className="p-8 text-center text-sm text-muted">No active students match these filters.</p> : null}
      </Card>
    </>
  );
}
