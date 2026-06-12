import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
};

const variants = {
  primary: "bg-teal-700 text-white hover:bg-teal-800 focus-visible:outline-teal-700",
  secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:outline-slate-500",
  danger: "bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700",
  ghost: "text-slate-700 hover:bg-slate-100 focus-visible:outline-slate-500",
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
        "inline-flex items-center justify-center rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        size === "sm" ? "h-9 px-3 text-sm" : "h-11 px-4 text-sm",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
});
