import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm", className)} {...props} />;
}

export function CardTitle({ children }: PropsWithChildren) {
  return <h2 className="text-base font-bold text-slate-950">{children}</h2>;
}
