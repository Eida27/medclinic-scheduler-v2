"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

export function ReportExportButton({
  query,
  disabled = false,
}: {
  query: string;
  disabled?: boolean;
}) {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string>();

  async function exportReport() {
    setIsExporting(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/reports/export/pdf${query ? `?${query}` : ""}`,
        { method: "GET" },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { message?: string } | undefined;
        throw new Error(payload?.message ?? "Unable to export the report. Try again.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? "compliance-report.pdf";
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (exportError) {
      setError(exportError instanceof Error
        ? exportError.message
        : "Unable to export the report. Try again.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="grid justify-items-end gap-2">
      <Button disabled={disabled || isExporting} onClick={exportReport}>
        {isExporting ? "Exporting PDF..." : "Export PDF"}
      </Button>
      {error ? <p role="alert" className="max-w-sm text-right text-sm font-semibold text-red-700">{error}</p> : null}
    </div>
  );
}
