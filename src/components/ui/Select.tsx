import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-sm outline-none transition duration-200 focus:border-cpu-navy focus:ring-4 focus:ring-cpu-navy/10 disabled:bg-canvas disabled:text-muted",
        className,
      )}
      {...props}
    />
  );
});
