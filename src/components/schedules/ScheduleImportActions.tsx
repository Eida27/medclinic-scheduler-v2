"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

type ScheduleImportStatus =
  | "DRAFT"
  | "VALIDATED"
  | "GENERATED"
  | "PUBLISHED"
  | "CANCELLED"
  | "NEEDS_REVIEW";

type ApiError = {
  message?: string;
  fields?: Record<string, string[] | string | undefined>;
};

type ErrorMessage = {
  text: string;
  details: string[];
};

function errorDetails(fields: ApiError["fields"]): string[] {
  return Object.values(fields ?? {}).flatMap((value) => {
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  });
}

export function ScheduleImportActions({
  importId,
  status,
}: {
  importId: string;
  status: ScheduleImportStatus;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorMessage>();
  const [overrideReason, setOverrideReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function submit(
    action: "validate" | "generate" | "publish",
    body?: Record<string, unknown>,
  ) {
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/schedule-imports/${encodeURIComponent(importId)}/${action}`,
        body
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) {
        const apiError = (payload.error ?? {}) as ApiError;
        setConfirmOpen(false);
        setError({
          text: apiError.message ?? "The schedule import action failed.",
          details: errorDetails(apiError.fields),
        });
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    } catch {
      setConfirmOpen(false);
      setError({
        text: "The schedule import action could not be completed.",
        details: [],
      });
    } finally {
      setPending(false);
    }
  }

  if (status === "PUBLISHED") {
    return (
      <div className="flex flex-wrap gap-3">
        <Link
          href="/laboratory"
          className="rounded-xl bg-cpu-navy px-4 py-2.5 text-sm font-bold text-white transition hover:bg-cpu-navy-light"
        >
          View Laboratory schedules
        </Link>
        <Link
          href="/physical-exam"
          className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-bold text-ink transition hover:bg-cpu-navy-soft"
        >
          View Physical exam schedules
        </Link>
      </div>
    );
  }

  if (status === "NEEDS_REVIEW") {
    return (
      <Alert tone="warning">
        This import&apos;s child batches are not synchronized. Review the clinic sections before taking any further action.
      </Alert>
    );
  }

  if (status === "CANCELLED") {
    return (
      <Alert tone="info">
        This cancelled import cannot be changed. Its details remain available for reference.
      </Alert>
    );
  }

  const pendingLabel = status === "DRAFT"
    ? "Validating..."
    : status === "VALIDATED"
      ? "Generating..."
      : "Publishing...";

  return (
    <div className="grid gap-4">
      {error ? (
        <Alert tone="danger">
          <p>{error.text}</p>
          {error.details.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {error.details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      {status === "VALIDATED" ? (
        <Field label="Capacity override reason (optional)">
          <Input
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            maxLength={500}
            disabled={pending}
            placeholder="Required only when approving a capacity conflict"
          />
        </Field>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {status === "DRAFT" ? (
          <Button onClick={() => submit("validate")} disabled={pending}>
            {pending ? pendingLabel : "Validate import"}
          </Button>
        ) : null}
        {status === "VALIDATED" ? (
          <Button
            onClick={() => submit("generate", overrideReason.trim()
              ? { overrideReason: overrideReason.trim() }
              : {})}
            disabled={pending}
          >
            {pending ? pendingLabel : "Generate appointments"}
          </Button>
        ) : null}
        {status === "GENERATED" ? (
          <Button onClick={() => setConfirmOpen(true)} disabled={pending}>
            {pending ? pendingLabel : "Publish schedules"}
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Publish imported schedules?"
        description="Publishing makes every generated appointment in this import visible to students and clinic staff."
        confirmLabel="Publish schedules"
        pending={pending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => submit("publish", { confirm: true })}
      />
    </div>
  );
}
