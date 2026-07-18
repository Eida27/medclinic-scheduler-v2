"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

type Draft = {
  appointmentId: string;
  resultType: "LABORATORY" | "PHYSICAL_EXAM";
  status: string;
  fileCount: number;
  totalBytes: number;
  files: Array<{ id: string; originalFilename: string; byteSize: number }>;
};

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export function ResultDraftManager({ draft }: { draft: Draft }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`/api/student/result-submissions/${draft.appointmentId}/files`, {
      method: "POST",
      body: form,
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) setError(payload.error?.message ?? "Unable to upload this file.");
    else {
      event.currentTarget.reset();
      router.refresh();
    }
  }

  return (
    <div className="grid gap-5">
      <Card className="p-5">
        <p className="font-bold">{draft.resultType === "LABORATORY" ? "Laboratory" : "Physical Examination"} draft</p>
        <p className="mt-1 text-sm text-muted">{draft.fileCount}/10 files · {formatBytes(draft.totalBytes)}/50 MB · {draft.status}</p>
        {draft.status === "DRAFT" ? <p className="mt-2 text-xs text-muted">Inactive drafts expire after seven days. Add or remove a file to keep this draft active.</p> : null}
      </Card>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {draft.status === "DRAFT" ? <form onSubmit={upload} className="flex flex-wrap items-end gap-3">
        <Input
          aria-label="Result file"
          name="file"
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          required
        />
        <Button type="submit" disabled={pending}>{pending ? "Uploading..." : "Add file"}</Button>
      </form> : <Alert tone="success">Finalized files are locked. You can download your own documents below.</Alert>}
      <div className="grid gap-3">
        {draft.files.map((file) => (
          <Card key={file.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div>
              <p className="font-semibold">{file.originalFilename}</p>
              <p className="text-xs text-muted">{formatBytes(file.byteSize)}</p>
            </div>
            {draft.status === "DRAFT" ? <Button
              variant="secondary"
              onClick={async () => {
                const response = await fetch(
                  `/api/student/result-submissions/${draft.appointmentId}/files/${file.id}`,
                  { method: "DELETE" },
                );
                if (!response.ok) {
                  const payload = await response.json();
                  setError(payload.error?.message ?? "Unable to remove this file.");
                } else router.refresh();
              }}
            >
              Remove
            </Button> : <a
              href={`/api/student/result-files/${file.id}`}
              className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold"
            >Download</a>}
          </Card>
        ))}
      </div>
      {draft.status === "DRAFT" && draft.fileCount ? (
        <Button
          variant="accent"
          disabled={pending}
          onClick={async () => {
            if (!window.confirm("Final submission locks this draft. Continue?")) return;
            setPending(true);
            const response = await fetch(`/api/student/result-submissions/${draft.appointmentId}/finalize`, {
              method: "POST",
            });
            const payload = await response.json();
            setPending(false);
            if (!response.ok) setError(payload.error?.message ?? "Unable to finalize this submission.");
            else router.refresh();
          }}
        >
          Final submit
        </Button>
      ) : null}
    </div>
  );
}
