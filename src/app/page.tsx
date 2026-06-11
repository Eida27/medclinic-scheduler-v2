import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col justify-between px-6 py-8 sm:px-10">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl bg-teal-400 font-black text-slate-950">MC</div>
            <div><p className="font-bold">MedClinic Scheduler</p><p className="text-xs text-slate-400">CPU Health Services</p></div>
          </div>
          <Link href="/login" className="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold transition hover:bg-white/10">Staff sign in</Link>
        </header>
        <section className="grid items-center gap-12 py-20 lg:grid-cols-[1.1fr_.9fr]">
          <div>
            <p className="mb-4 text-sm font-bold uppercase tracking-[0.2em] text-teal-300">Clinic scheduling and compliance</p>
            <h1 className="max-w-3xl text-4xl font-black leading-tight sm:text-6xl">Clear schedules. Visible capacity. Better student follow-through.</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">Organize coordinator submissions, publish validated appointments, and track physical examination and laboratory completion in one focused system.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/student-lookup" className="rounded-xl bg-teal-400 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-teal-300">Find my schedule</Link>
              <Link href="/login" className="rounded-xl border border-white/20 px-5 py-3 text-sm font-bold transition hover:bg-white/10">Open staff dashboard</Link>
            </div>
          </div>
          <div className="grid gap-4 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
            {[
              ["120", "Recommended daily capacity per service"],
              ["150", "Maximum before admin override"],
              ["2", "Independent physical and laboratory tracks"],
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl bg-white/10 p-5"><p className="text-3xl font-black text-teal-300">{value}</p><p className="mt-1 text-sm text-slate-300">{label}</p></div>
            ))}
          </div>
        </section>
        <footer className="text-xs text-slate-500">Central Philippine University clinic scheduling MVP</footer>
      </div>
    </main>
  );
}
