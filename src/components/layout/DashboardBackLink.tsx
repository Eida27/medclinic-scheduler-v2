"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const backLinks = {
  appointments: { href: "/appointments", label: "Back to appointments" },
  students: { href: "/students", label: "Back to students" },
  "coordinator-schedules": {
    href: "/coordinator-schedules",
    label: "Back to coordinator schedules",
  },
} as const;

const scheduleImportsBackLink = {
  href: "/students?view=schedule-imports",
  label: "Back to schedule imports",
} as const;

function getBackLink(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length === 3
    && segments[0] === "students"
    && segments[1] === "schedule-imports"
  ) {
    return scheduleImportsBackLink;
  }
  if (segments.length !== 2 || segments[1] === "new") return null;

  return backLinks[segments[0] as keyof typeof backLinks] ?? null;
}

export function DashboardBackLink() {
  const backLink = getBackLink(usePathname());

  if (!backLink) return null;

  return (
    <Link
      href={backLink.href}
      aria-label={backLink.label}
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-muted-strong transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft hover:text-cpu-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.8">
        <path d="M15.5 10H4.5m0 0 4-4m-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="hidden sm:inline">{backLink.label}</span>
    </Link>
  );
}
