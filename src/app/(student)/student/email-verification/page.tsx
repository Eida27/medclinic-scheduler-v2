import { redirect } from "next/navigation";
import { EmailVerificationForm } from "@/components/student/EmailVerificationForm";
import { Card } from "@/components/ui/Card";
import { requireStudent } from "@/server/auth/current-student";

export default async function StudentEmailVerificationPage() {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  return (
    <section className="max-w-2xl">
      <h1 className="text-3xl font-bold">Email verification</h1>
      <Card className="mt-6 p-6">
        <EmailVerificationForm verifiedEmail={student.emailVerifiedAt ? student.email : null} />
      </Card>
    </section>
  );
}
