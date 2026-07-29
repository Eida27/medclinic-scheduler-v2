"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";

type AppointmentQuickStatusButtonProps = {
  appointmentId: string;
  status: string;
  completedFromStatus: "PENDING" | "NO_SHOW" | null;
};

type QuickStatusAction = "MARK_COMPLETED" | "REVERT_COMPLETION";

type QuickStatusConfig = {
  label: string;
  quickStatusAction: QuickStatusAction;
  expectedStatus: "PENDING" | "NO_SHOW" | "COMPLETED";
  tone: "pending" | "noShow" | "completed";
  confirmation?: {
    title: string;
    description: string;
    confirmLabel: string;
    danger?: boolean;
  };
};

function quickStatusConfig(
  status: string,
  completedFromStatus: "PENDING" | "NO_SHOW" | null,
): QuickStatusConfig | null {
  if (status === "PENDING") {
    return {
      label: "Pending — click to mark completed",
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "PENDING",
      tone: "pending",
    };
  }
  if (status === "NO_SHOW") {
    return {
      label: "No-show — click to correct as completed",
      quickStatusAction: "MARK_COMPLETED",
      expectedStatus: "NO_SHOW",
      tone: "noShow",
      confirmation: {
        title: "Correct no-show as completed?",
        description: "This automatic no-show will be corrected to Completed. No reason is required.",
        confirmLabel: "Mark as completed",
      },
    };
  }
  if (status === "COMPLETED" && completedFromStatus === "PENDING") {
    return {
      label: "Completed — click to restore pending",
      quickStatusAction: "REVERT_COMPLETION",
      expectedStatus: "COMPLETED",
      tone: "completed",
    };
  }
  if (status === "COMPLETED" && completedFromStatus === "NO_SHOW") {
    return {
      label: "Completed — click to restore no-show",
      quickStatusAction: "REVERT_COMPLETION",
      expectedStatus: "COMPLETED",
      tone: "completed",
      confirmation: {
        title: "Restore automatic no-show?",
        description: "This appointment will return to No-show. No reason is required.",
        confirmLabel: "Restore no-show",
        danger: true,
      },
    };
  }
  return null;
}

const toneClasses = {
  pending: "bg-slate-100 text-slate-800 hover:bg-slate-200 focus-visible:outline-slate-600",
  noShow: "bg-red-100 text-red-800 hover:bg-red-200 focus-visible:outline-red-700",
  completed: "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 focus-visible:outline-emerald-700",
};

export function AppointmentQuickStatusButton({
  appointmentId,
  status,
  completedFromStatus,
}: AppointmentQuickStatusButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [error, setError] = useState<string>();
  const config = quickStatusConfig(status, completedFromStatus);
  const disabledLabel = status === "COMPLETED"
    ? "Completed — previous status unavailable"
    : `${status.replaceAll("_", " ")} — quick status unavailable`;

  async function submit() {
    if (!config || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quickStatusAction: config.quickStatusAction,
          expectedStatus: config.expectedStatus,
        }),
      });
      if (!response.ok) {
        const payload = await response.json();
        setError(payload.error?.message ?? "Unable to update the appointment status.");
        return;
      }
      setConfirmationOpen(false);
      router.refresh();
    } catch {
      setError("Unable to update the appointment status. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function activate(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!config || pending) return;
    setError(undefined);
    if (config.confirmation) {
      setConfirmationOpen(true);
      return;
    }
    void submit();
  }

  return (
    <div className="grid justify-items-start gap-2">
      <button
        type="button"
        disabled={!config || pending}
        aria-busy={pending}
        onClick={activate}
        className={cn(
          "inline-flex min-h-9 items-center rounded-full px-3 py-1.5 text-left text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
          config ? toneClasses[config.tone] : "bg-emerald-100 text-emerald-800",
        )}
      >
        {pending ? "Updating..." : config?.label ?? disabledLabel}
      </button>
      {error && !confirmationOpen ? (
        <p role="alert" className="max-w-xs text-xs font-medium text-red-700">{error}</p>
      ) : null}
      {config?.confirmation ? (
        <ConfirmDialog
          open={confirmationOpen}
          title={config.confirmation.title}
          description={config.confirmation.description}
          error={error}
          confirmLabel={config.confirmation.confirmLabel}
          pending={pending}
          pendingLabel="Updating..."
          danger={config.confirmation.danger}
          onCancel={() => {
            if (!pending) {
              setConfirmationOpen(false);
              setError(undefined);
            }
          }}
          onConfirm={() => void submit()}
        />
      ) : null}
    </div>
  );
}
