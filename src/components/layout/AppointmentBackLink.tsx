"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const appointmentDetailPath = /^\/appointments\/[^/]+\/?$/;

export function AppointmentBackLink() {
  const pathname = usePathname();

  if (!appointmentDetailPath.test(pathname)) return null;

  return (
    <Link
      href="/appointments"
      aria-label="Back to appointments"
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-muted-strong transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft hover:text-cpu-navy focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.8">
        <path d="M15.5 10H4.5m0 0 4-4m-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="hidden sm:inline">Back to appointments</span>
    </Link>
  );
}
