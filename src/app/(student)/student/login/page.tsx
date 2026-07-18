import { redirect } from "next/navigation";
import { BrandMark } from "@/components/branding/BrandMark";
import { StudentLoginForm } from "@/components/student/StudentLoginForm";
import { Card } from "@/components/ui/Card";
import { optionalStudent } from "@/server/auth/current-student";

export default async function StudentLoginPage() {
  if (await optionalStudent()) redirect("/student");
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-canvas p-4">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-52 bg-cpu-navy" />
      <Card className="relative w-full max-w-md rounded-3xl p-7 sm:p-9">
        <BrandMark priority />
        <div className="mb-6 mt-7 h-1.5 w-14 rounded-full bg-cpu-gold" />
        <h1 className="text-2xl font-bold tracking-tight text-ink">Student sign in</h1>
        <p className="mb-6 mt-2 text-sm leading-6 text-muted">
          Use your Student Number and date of birth to view your schedule and results.
        </p>
        <StudentLoginForm />
      </Card>
    </main>
  );
}
