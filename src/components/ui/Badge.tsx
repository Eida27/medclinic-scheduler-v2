import type { PropsWithChildren } from "react";
import { cn } from "@/lib/cn";

export function Badge({ children, tone = "neutral" }: PropsWithChildren<{ tone?: "neutral" | "success" | "warning" | "danger" | "info" }>) {
  const tones = {
    neutral: "bg-cpu-navy-soft text-cpu-navy",
    success: "bg-emerald-100 text-emerald-800",
    warning: "bg-amber-100 text-amber-900",
    danger: "bg-red-100 text-red-800",
    info: "bg-blue-100 text-blue-900",
  };
  return <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-bold tracking-wide", tones[tone])}>{children}</span>;
}
