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
        <section className="py-20">
          <h1 className="max-w-3xl text-4xl font-black leading-tight sm:text-6xl">Central Philippine University Laboratory and Physical Examination</h1>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/student-lookup" className="rounded-xl bg-teal-400 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-teal-300">Find my schedule</Link>
            <Link href="/login" className="rounded-xl border border-white/20 px-5 py-3 text-sm font-bold transition hover:bg-white/10">Open staff dashboard</Link>
          </div>
        </section>
        <footer className="text-xs text-slate-500">Central Philippine University clinic scheduling MVP</footer>
      </div>
    </main>
  );
}
