import type { PropsWithChildren } from "react";

export function Field({ label, error, children }: PropsWithChildren<{ label: string; error?: string }>) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-slate-800">
      <span>{label}</span>
      {children}
      {error ? <span className="text-xs font-medium text-red-700">{error}</span> : null}
    </label>
  );
}
