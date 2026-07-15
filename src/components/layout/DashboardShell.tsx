import type { PropsWithChildren } from "react";
import type { SessionUser } from "@/types/roles";
import { DashboardBackLink } from "./DashboardBackLink";
import { LogoutButton } from "./LogoutButton";
import { Sidebar } from "./Sidebar";

export function DashboardShell({ user, children }: PropsWithChildren<{ user: SessionUser }>) {
  const roleLabel = user.role === "ADMIN"
    ? "Administrator"
    : user.role === "COORDINATOR"
      ? "Coordinator"
      : "Clinic staff";

  return (
    <div className="min-h-screen bg-canvas lg:flex">
      <Sidebar user={user} />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur sm:px-6 lg:h-18 lg:px-8">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <DashboardBackLink />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-ink">{user.fullName}</p>
              <p className="text-xs text-muted">{roleLabel}</p>
            </div>
          </div>
          <LogoutButton />
        </header>
        <main className="mx-auto grid max-w-[1500px] gap-6 p-4 sm:p-6 lg:gap-7 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
