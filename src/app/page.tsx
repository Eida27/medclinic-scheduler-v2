import Link from "next/link";
import { BrandMark } from "@/components/branding/BrandMark";
import { ClinicHeroIllustration } from "@/components/landing/ClinicHeroIllustration";

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-landing text-cpu-navy">
      <div aria-hidden="true" className="absolute -left-32 top-28 size-80 rounded-full bg-cpu-gold/8 blur-3xl" />
      <div aria-hidden="true" className="absolute -right-40 -top-24 size-96 rounded-full bg-white/80 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 py-5 sm:px-8 sm:py-7 lg:px-12">
        <header className="flex items-center gap-4">
          <BrandMark priority />
        </header>

        <section className="grid flex-1 items-center gap-8 py-12 md:py-16 lg:grid-cols-[minmax(0,1.08fr)_minmax(360px,0.92fr)] lg:gap-12 lg:py-12">
          <div className="max-w-3xl">
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-cpu-gold-dark">CPU Health Services</p>
            <h1 className="text-4xl font-black leading-[1.08] tracking-[-0.04em] text-cpu-navy sm:text-5xl lg:text-6xl">
              Central Philippine University Laboratory and Physical Examination
            </h1>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              <Link
                href="/student/login"
                className="rounded-xl bg-cpu-gold px-6 py-4 text-cpu-navy shadow-sm transition duration-200 hover:bg-cpu-gold-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold-dark"
              >
                <span className="block text-sm font-bold">Student sign in</span>
                <span className="mt-1 block text-sm font-medium">View your schedule and submit results.</span>
              </Link>
              <Link
                href="/login"
                className="rounded-xl border border-cpu-navy/30 bg-white/45 px-6 py-4 text-cpu-navy transition duration-200 hover:border-cpu-navy/60 hover:bg-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
              >
                <span className="block text-sm font-bold">Staff sign in</span>
                <span className="mt-1 block text-sm font-medium">For administrators, coordinators and clinic staff.</span>
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
