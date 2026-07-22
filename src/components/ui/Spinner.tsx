import { cn } from "@/lib/cn";

type SpinnerProps = {
  size?: "sm" | "md";
  label?: string;
  className?: string;
};

export function Spinner({ size = "md", label = "Loading", className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-r-transparent",
        size === "sm" ? "h-4 w-4" : "h-5 w-5",
        className,
      )}
    />
  );
}
