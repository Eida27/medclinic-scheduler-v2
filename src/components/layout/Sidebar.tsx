import Link from "next/link";
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
  return (
    <aside className="border-b border-slate-200 bg-slate-950 text-white lg:min-h-screen lg:w-64 lg:border-b-0 lg:border-r">
      <div className="flex h-18 items-center gap-3 px-5 py-4">
        <div className="grid size-10 place-items-center rounded-xl bg-teal-500 font-black text-slate-950">MC</div>
        <div>
          <p className="font-bold">MedClinic</p>
          <p className="text-xs text-slate-400">CPU Health Services</p>
        </div>
      </div>
      <nav aria-label="Dashboard navigation" className="flex gap-1 overflow-x-auto px-3 pb-4 lg:block lg:space-y-1">
        {primaryLinks.map(([label, href]) => (
          <Link key={href} href={href} className="block whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
            {label}
          </Link>
        ))}
        {user.role === "ADMIN" ? (
          <>
            <p className="hidden px-3 pb-1 pt-5 text-xs font-bold uppercase tracking-wider text-slate-500 lg:block">Administration</p>
            {adminLinks.map(([label, href]) => (
              <Link key={href} href={href} className="block whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
                {label}
              </Link>
            ))}
          </>
        ) : null}
      </nav>
    </aside>
  );
}
