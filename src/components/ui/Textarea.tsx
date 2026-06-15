import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-24 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm outline-none transition duration-200 placeholder:text-muted/70 focus:border-cpu-navy focus:ring-4 focus:ring-cpu-navy/10",
        className,
      )}
      {...props}
    />
  );
});
