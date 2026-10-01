import { redirect } from "next/navigation";
import { EmailVerificationForm } from "@/components/student/EmailVerificationForm";
import { Card } from "@/components/ui/Card";
import { parseStudentVerificationReturn } from "@/lib/student-verification-return";
import { requireStudent } from "@/server/auth/current-student";

type Props = { searchParams: Promise<{ returnTo?: string | string[] }> };

export default async function StudentEmailVerificationPage({ searchParams }: Props) {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  const returnTo = parseStudentVerificationReturn((await searchParams).returnTo);
  if (student.emailVerifiedAt && returnTo) redirect(returnTo);
  return (
    <section className="max-w-2xl">
      <h1 className="text-3xl font-bold">Email verification</h1>
      <Card className="mt-6 p-6">
        <EmailVerificationForm verifiedEmail={student.emailVerifiedAt ? student.email : null} returnTo={returnTo ?? "/student"} />
      </Card>
    </section>
  );
}
