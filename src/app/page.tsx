import Link from "next/link";
import { BrandMark } from "@/components/branding/BrandMark";
import { ClinicHeroIllustration } from "@/components/landing/ClinicHeroIllustration";

type BenefitIconProps = {
  type: "calendar" | "shield" | "users";
};

function BenefitIcon({ type }: BenefitIconProps) {
  if (type === "calendar") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-8 shrink-0 fill-none stroke-current" strokeWidth="1.8">
        <rect x="5" y="7" width="22" height="20" rx="3" />
        <path d="M10 4v6M22 4v6M5 13h22M10 18h4M18 18h4M10 22h4" />
      </svg>
    );
  }

  if (type === "shield") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-8 shrink-0 fill-none stroke-current" strokeWidth="1.8">
        <path d="M16 4 26 8v7c0 6.4-4 10.8-10 13-6-2.2-10-6.6-10-13V8Z" />
        <path d="m11.5 16 3 3 6-6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="size-8 shrink-0 fill-none stroke-current" strokeWidth="1.8">
      <circle cx="12" cy="11" r="4" />
      <circle cx="22" cy="13" r="3" />
      <path d="M4.5 27v-3a7.5 7.5 0 0 1 15 0v3M19 19.5a6 6 0 0 1 8.5 5.5v2" />
    </svg>
  );
}

const benefits = [
  {
    title: "Published schedules",
    description: "View your confirmed appointments.",
    icon: "calendar" as const,
  },
  {
    title: "Secure & private",
    description: "Your data is protected at all times.",
    icon: "shield" as const,
  },
  {
    title: "For CPU students",
    description: "Built for the CPU community.",
    icon: "users" as const,
  },
];

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
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-strong sm:text-lg">
              Easy access to your clinic schedule. Safe, organized, and built for the CPU community.
            </p>
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
            </div>
          </div>

          <div className="mx-auto w-full max-w-xl lg:max-w-none">
            <ClinicHeroIllustration />
          </div>
        </section>

        <section aria-label="Service benefits" className="mb-2 overflow-hidden rounded-2xl border border-landing-line bg-white/55 shadow-panel backdrop-blur-sm">
          <div className="grid md:grid-cols-3">
            {benefits.map((benefit, index) => (
              <article
                key={benefit.title}
                className={`flex items-start gap-4 px-5 py-5 sm:px-7 ${index > 0 ? "border-t border-landing-line md:border-l md:border-t-0" : ""}`}
              >
                <span className="mt-0.5 text-cpu-navy" aria-hidden="true">
                  <BenefitIcon type={benefit.icon} />
                </span>
                <div>
                  <h2 className="text-sm font-bold text-cpu-navy">{benefit.title}</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-strong">{benefit.description}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
