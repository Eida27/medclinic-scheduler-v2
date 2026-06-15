import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "accent" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
};

const variants = {
  primary: "bg-cpu-navy text-white shadow-sm hover:bg-cpu-navy-light focus-visible:outline-cpu-navy",
  accent: "bg-cpu-gold text-cpu-navy shadow-sm hover:bg-cpu-gold-light focus-visible:outline-cpu-gold-dark",
  secondary: "border border-line bg-surface text-ink hover:border-cpu-navy/25 hover:bg-canvas focus-visible:outline-cpu-navy",
  danger: "bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700",
  ghost: "text-muted-strong hover:bg-cpu-navy-soft hover:text-cpu-navy focus-visible:outline-cpu-navy",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-xl font-semibold transition duration-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        size === "sm" ? "h-9 px-3 text-sm" : "h-11 px-4 text-sm",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
});
