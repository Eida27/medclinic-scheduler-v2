import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl border border-line bg-surface p-5 shadow-panel", className)} {...props} />;
}

export function CardTitle({ children }: PropsWithChildren) {
  return <h2 className="text-base font-bold tracking-tight text-ink">{children}</h2>;
}
