import type { PropsWithChildren } from "react";
import type { SessionUser } from "@/types/roles";
import { LogoutButton } from "./LogoutButton";
import { Sidebar } from "./Sidebar";

export function DashboardShell({ user, children }: PropsWithChildren<{ user: SessionUser }>) {
  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      <Sidebar user={user} />
      <div className="min-w-0 flex-1">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div>
            <p className="text-sm font-bold text-slate-900">{user.fullName}</p>
            <p className="text-xs text-slate-500">{user.role === "ADMIN" ? "Administrator" : "Clinic staff"}</p>
          </div>
          <LogoutButton />
        </header>
        <main className="mx-auto grid max-w-[1500px] gap-6 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
