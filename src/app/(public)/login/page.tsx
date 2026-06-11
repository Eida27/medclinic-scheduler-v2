import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForm";
import { Card } from "@/components/ui/Card";
import { optionalUser } from "@/server/auth/current-user";

export default async function LoginPage() {
  if (await optionalUser()) redirect("/dashboard");

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,_#ccfbf1,_transparent_42%),linear-gradient(135deg,#f8fafc,#ecfeff)] p-4">
      <Card className="w-full max-w-md p-7 sm:p-9">
        <div className="mb-7">
          <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-teal-700 font-black text-white">MC</div>
          <h1 className="text-2xl font-bold text-slate-950">Clinic staff sign in</h1>
          <p className="mt-2 text-sm text-slate-600">Manage student schedules, appointments, and compliance records.</p>
        </div>
        <LoginForm />
        <p className="mt-6 text-xs text-slate-500">Demo admin: admin@medclinic.local / Admin123!</p>
      </Card>
    </main>
  );
}
