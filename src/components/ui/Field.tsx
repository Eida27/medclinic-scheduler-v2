import type { PropsWithChildren } from "react";

export function Field({
  label,
  error,
  errorId,
  children,
}: PropsWithChildren<{ label: string; error?: string; errorId?: string }>) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-muted-strong">
      <span>{label}</span>
      {children}
      {error ? <span id={errorId} className="text-xs font-medium text-red-700">{error}</span> : null}
    </label>
  );
}
