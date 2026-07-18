import Link from "next/link";
import type { PropsWithChildren } from "react";
import { BrandMark } from "@/components/branding/BrandMark";
import { StudentLogoutButton } from "@/components/student/StudentLogoutButton";
import { optionalStudent } from "@/server/auth/current-student";

export default async function StudentLayout({ children }: PropsWithChildren) {
  const student = await optionalStudent();
  if (!student) return children;
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <BrandMark />
          <nav aria-label="Student portal" className="flex flex-wrap items-center gap-4 text-sm font-semibold">
            <Link href="/student">Schedule</Link>
            <Link href="/student/notifications">Notifications</Link>
            <Link href="/student/email-verification">Email verification</Link>
            <Link href="/student/results">Results</Link>
          </nav>
          <StudentLogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}
