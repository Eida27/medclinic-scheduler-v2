import Link from "next/link";
import { BrandMark } from "@/components/branding/BrandMark";

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-cpu-navy text-white">
      <div aria-hidden="true" className="absolute -right-28 top-20 size-80 rounded-full border-[52px] border-cpu-gold/10 sm:size-[32rem]" />
      <div aria-hidden="true" className="absolute bottom-0 left-0 h-1.5 w-full bg-cpu-gold" />
      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col justify-between px-6 py-7 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between">
          <BrandMark inverse priority />
          <Link href="/login" className="rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold transition duration-200 hover:border-cpu-gold/50 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold">Staff sign in</Link>
        </header>
        <section className="py-20 sm:py-28">
          <div className="mb-7 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.22em] text-cpu-gold">
            <span className="h-px w-10 bg-cpu-gold" />
            University health scheduling
          </div>
          <h1 className="max-w-4xl text-4xl font-black leading-[1.05] tracking-[-0.04em] sm:text-6xl lg:text-7xl">Central Philippine University Laboratory and Physical Examination</h1>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/student-lookup" className="rounded-xl bg-cpu-gold px-5 py-3 text-sm font-bold text-cpu-navy shadow-lg shadow-black/10 transition duration-200 hover:bg-cpu-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Find my schedule</Link>
            <Link href="/login" className="rounded-xl border border-white/20 bg-white/5 px-5 py-3 text-sm font-bold transition duration-200 hover:border-white/40 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold">Open staff dashboard</Link>
          </div>
        </section>
        <footer className="pb-3 text-xs text-white/60">Central Philippine University clinic scheduling MVP</footer>
      </div>
    </main>
  );
}
