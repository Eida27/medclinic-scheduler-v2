import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForm";
import { BrandMark } from "@/components/branding/BrandMark";
import { Card } from "@/components/ui/Card";
import { optionalUser } from "@/server/auth/current-user";

export default async function LoginPage() {
  if (await optionalUser()) redirect("/dashboard");

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-canvas p-4">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-52 bg-cpu-navy" />
      <div aria-hidden="true" className="absolute left-[8%] top-24 size-28 rounded-full border-[18px] border-cpu-gold/30" />
      <Card className="relative w-full max-w-md rounded-3xl p-7 sm:p-9">
        <div className="mb-7">
          <BrandMark priority />
          <div className="mb-6 mt-7 h-1.5 w-14 rounded-full bg-cpu-gold" />
          <h1 className="text-2xl font-bold tracking-tight text-ink">Clinic staff sign in</h1>
          <p className="mt-2 text-sm leading-6 text-muted">Manage student schedules, appointments, and compliance records.</p>
        </div>
        <LoginForm />
        <p className="mt-6 rounded-xl bg-cpu-navy-soft px-3 py-2 text-xs text-muted-strong">Demo admin: admin@medclinic.local / Admin123!</p>
      </Card>
    </main>
  );
}
