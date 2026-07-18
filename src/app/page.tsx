import Link from "next/link";
import { BrandMark } from "@/components/branding/BrandMark";
import { ClinicHeroIllustration } from "@/components/landing/ClinicHeroIllustration";

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-landing text-cpu-navy">
      <div aria-hidden="true" className="absolute -left-32 top-28 size-80 rounded-full bg-cpu-gold/8 blur-3xl" />
      <div aria-hidden="true" className="absolute -right-40 -top-24 size-96 rounded-full bg-white/80 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 py-5 sm:px-8 sm:py-7 lg:px-12">
        <header className="flex items-center justify-between gap-4">
          <BrandMark priority />
          <Link
            href="/login"
            className="shrink-0 rounded-lg bg-cpu-navy px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition duration-200 hover:bg-cpu-navy-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold-dark"
          >
            Staff sign in
          </Link>
        </header>

        <section className="grid flex-1 items-center gap-8 py-12 md:py-16 lg:grid-cols-[minmax(0,1.08fr)_minmax(360px,0.92fr)] lg:gap-12 lg:py-12">
          <div className="max-w-3xl">
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-cpu-gold-dark">CPU Health Services</p>
            <h1 className="text-4xl font-black leading-[1.08] tracking-[-0.04em] text-cpu-navy sm:text-5xl lg:text-6xl">
              Central Philippine University Laboratory and Physical Examination
            </h1>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                href="/student-lookup"
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-cpu-gold px-6 py-3 text-sm font-bold text-cpu-navy shadow-sm transition duration-200 hover:bg-cpu-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold-dark"
              >
                Find my schedule
              </Link>
              <Link
                href="/login"
                className="inline-flex min-h-12 items-center justify-center rounded-lg border border-cpu-navy/30 bg-white/45 px-6 py-3 text-sm font-bold text-cpu-navy transition duration-200 hover:border-cpu-navy/60 hover:bg-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
              >
                Open staff dashboard
              </Link>
              <Link
                href="/student/login"
                className="inline-flex min-h-12 items-center justify-center rounded-lg border border-cpu-navy/30 bg-white/45 px-6 py-3 text-sm font-bold text-cpu-navy transition duration-200 hover:border-cpu-navy/60 hover:bg-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
              >
                Student sign in
              </Link>
            </div>
          </div>

          <div className="mx-auto w-full max-w-xl lg:max-w-none">
            <ClinicHeroIllustration />
          </div>
        </section>

      </div>
    </main>
  );
}
