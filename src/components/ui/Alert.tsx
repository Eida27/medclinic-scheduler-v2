import type { PropsWithChildren } from "react";
import { cn } from "@/lib/cn";

export function Alert({ children, tone = "info" }: PropsWithChildren<{ tone?: "info" | "success" | "warning" | "danger" }>) {
  const tones = {
    info: "border-cpu-navy/15 bg-cpu-navy-soft text-cpu-navy",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-amber-200 bg-amber-50 text-amber-950",
    danger: "border-red-200 bg-red-50 text-red-900",
  };
  return <div role="alert" className={cn("rounded-xl border px-4 py-3 text-sm font-medium shadow-sm", tones[tone])}>{children}</div>;
}
