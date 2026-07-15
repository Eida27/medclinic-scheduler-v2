"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { College, Program } from "@/server/repositories/reference-data.repository";

type Student = {
  studentNumber: string; firstName: string; middleName: string | null; lastName: string; suffix: string | null;
  collegeId: string; programId: string; yearLevel: number | null; section: string | null;
};

export function StudentForm({
  colleges,
  programs,
  student,
  readOnly = false,
}: {
  colleges: College[];
  programs: Program[];
  student?: Student;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [collegeId, setCollegeId] = useState(student?.collegeId ?? "");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const availablePrograms = useMemo(() => programs.filter((program) => program.collegeId === collegeId && program.isActive), [collegeId, programs]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly) return;
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const body = {
      studentNumber: form.get("studentNumber"), firstName: form.get("firstName"), middleName: form.get("middleName"),
      lastName: form.get("lastName"), suffix: form.get("suffix"), collegeId: form.get("collegeId"),
      programId: form.get("programId"), yearLevel: Number(form.get("yearLevel")) || null, section: form.get("section"),
    };
    const response = await fetch(student ? `/api/students/${encodeURIComponent(student.studentNumber)}` : "/api/students", {
      method: student ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error?.message ?? "Unable to save student."); setPending(false); return; }
    router.push(`/students/${encodeURIComponent(payload.data.studentNumber)}`);
    router.refresh();
  }

  return (
    <Card className="max-w-4xl">
      <form onSubmit={submit} className="grid gap-5">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Student number"><Input name="studentNumber" defaultValue={student?.studentNumber} disabled={Boolean(student) || readOnly} required /></Field>
          <Field label="First name"><Input name="firstName" defaultValue={student?.firstName} disabled={readOnly} required /></Field>
          <Field label="Middle name"><Input name="middleName" defaultValue={student?.middleName ?? ""} disabled={readOnly} /></Field>
          <Field label="Last name"><Input name="lastName" defaultValue={student?.lastName} disabled={readOnly} required /></Field>
          <Field label="Suffix"><Input name="suffix" defaultValue={student?.suffix ?? ""} disabled={readOnly} /></Field>
          <Field label="College">
            <Select name="collegeId" value={collegeId} onChange={(event) => setCollegeId(event.target.value)} disabled={readOnly} required>
              <option value="">Select college</option>{colleges.filter((college) => college.isActive).map((college) => <option key={college.id} value={college.id}>{college.name}</option>)}
            </Select>
          </Field>
          <Field label="Program">
            <Select name="programId" defaultValue={student?.programId} key={collegeId} disabled={readOnly} required>
              <option value="">Select program</option>{availablePrograms.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
            </Select>
          </Field>
          <Field label="Year level"><Select name="yearLevel" defaultValue={student?.yearLevel ?? ""} disabled={readOnly}><option value="">Not specified</option>{[1,2,3,4,5,6].map((year) => <option key={year} value={year}>{year}</option>)}</Select></Field>
          <Field label="Section"><Input name="section" defaultValue={student?.section ?? ""} disabled={readOnly} /></Field>
        </div>
        {readOnly ? null : <div className="flex gap-3"><Button type="submit" disabled={pending}>{pending ? "Saving..." : student ? "Save changes" : "Add student"}</Button><Button variant="secondary" onClick={() => router.back()}>Cancel</Button></div>}
      </form>
    </Card>
  );
}
