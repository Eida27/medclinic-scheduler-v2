import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-sm outline-none transition duration-200 placeholder:text-muted/70 focus:border-cpu-navy focus:ring-4 focus:ring-cpu-navy/10 disabled:bg-canvas disabled:text-muted",
        className,
      )}
      {...props}
    />
  );
});
