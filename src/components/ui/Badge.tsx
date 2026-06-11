import type { PropsWithChildren } from "react";
import { cn } from "@/lib/cn";

export function Badge({ children, tone = "neutral" }: PropsWithChildren<{ tone?: "neutral" | "success" | "warning" | "danger" | "info" }>) {
  const tones = {
    neutral: "bg-slate-100 text-slate-700",
    success: "bg-emerald-100 text-emerald-800",
    warning: "bg-amber-100 text-amber-900",
    danger: "bg-red-100 text-red-800",
    info: "bg-indigo-100 text-indigo-800",
  };
  return <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-bold", tones[tone])}>{children}</span>;
}
