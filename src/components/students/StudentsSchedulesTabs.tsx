import Link from "next/link";
import { cn } from "@/lib/cn";

type StudentsSchedulesView = "students" | "schedule-imports";

export function StudentsSchedulesTabs({
  activeView,
  canManageImports,
}: {
  activeView: StudentsSchedulesView;
  canManageImports: boolean;
}) {
  const tabs: Array<{ label: string; href: string; view: StudentsSchedulesView }> = [
    { label: "Students", href: "/students", view: "students" },
  ];
  if (canManageImports) {
    tabs.push({
      label: "Schedule Imports",
      href: "/students?view=schedule-imports",
      view: "schedule-imports",
    });
  }

  return (
    <nav aria-label="Students and schedules views" className="flex gap-1 border-b border-line">
      {tabs.map((tab) => {
        const isActive = tab.view === activeView;
        return (
          <Link
            key={tab.view}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "border-b-2 px-4 py-3 text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy",
              isActive
                ? "border-cpu-navy text-cpu-navy"
                : "border-transparent text-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
