"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/branding/BrandMark";
import { cn } from "@/lib/cn";
import type { SessionUser } from "@/types/roles";

const primaryLinks = [
  ["Dashboard", "/dashboard"],
  ["Students", "/students"],
  ["Coordinator schedules", "/coordinator-schedules"],
  ["Appointments", "/appointments"],
  ["Compliance", "/compliance"],
  ["Results", "/results"],
] as const;

const adminLinks = [
  ["Users", "/settings/users"],
  ["Reference data", "/settings/reference-data"],
  ["Capacity", "/settings/capacity"],
] as const;

export function Sidebar({ user }: { user: SessionUser }) {
  const pathname = usePathname();

  function isActive(href: string) {
    return pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));
  }

  return (
    <aside className="border-b border-white/10 bg-cpu-navy text-white lg:min-h-screen lg:w-72 lg:border-b-0 lg:border-r">
      <div className="flex min-h-20 items-center px-5 py-4 lg:px-6">
        <BrandMark inverse />
      </div>
      <nav aria-label="Dashboard navigation" className="scrollbar-none flex gap-1 overflow-x-auto px-3 pb-4 lg:block lg:space-y-1 lg:px-4">
        {primaryLinks.map(([label, href]) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? "page" : undefined}
            className={cn(
              "block whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold",
              isActive(href)
                ? "bg-cpu-gold text-cpu-navy shadow-sm"
                : "text-white/70 hover:bg-white/10 hover:text-white",
            )}
          >
            {label}
          </Link>
        ))}
        {user.role === "ADMIN" ? (
          <>
            <p className="hidden px-3 pb-1 pt-5 text-xs font-bold uppercase tracking-[0.16em] text-white/60 lg:block">Administration</p>
            {adminLinks.map(([label, href]) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(href) ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-gold",
                  isActive(href)
                    ? "bg-cpu-gold text-cpu-navy shadow-sm"
                    : "text-white/70 hover:bg-white/10 hover:text-white",
                )}
              >
                {label}
              </Link>
            ))}
          </>
        ) : null}
      </nav>
    </aside>
  );
}
