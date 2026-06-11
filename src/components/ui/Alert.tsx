import type { PropsWithChildren } from "react";
import { cn } from "@/lib/cn";

export function Alert({ children, tone = "info" }: PropsWithChildren<{ tone?: "info" | "success" | "warning" | "danger" }>) {
  const tones = {
    info: "border-blue-200 bg-blue-50 text-blue-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-amber-200 bg-amber-50 text-amber-950",
    danger: "border-red-200 bg-red-50 text-red-900",
  };
  return <div role="alert" className={cn("rounded-xl border px-4 py-3 text-sm", tones[tone])}>{children}</div>;
}
