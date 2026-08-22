import { forbidden, redirect } from "next/navigation";
import type { PropsWithChildren } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { AppError } from "@/lib/errors";
import { optionalStudent } from "@/server/auth/current-student";
import { requireUser } from "@/server/auth/current-user";

export default async function ProtectedLayout({ children }: PropsWithChildren) {
  const user = await authenticatedUser();
  return <DashboardShell user={user}>{children}</DashboardShell>;
}

async function authenticatedUser() {
  try {
    return await requireUser();
  } catch (error) {
    if (error instanceof AppError && error.status === 401 && await optionalStudent()) {
      forbidden();
    }
    redirect("/login");
  }
}
