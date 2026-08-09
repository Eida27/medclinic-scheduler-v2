"use client";

import { useRouter } from "next/navigation";
import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { RESULT_FILE_ACCEPT } from "@/shared/student-result-file-rules";
import { validateResultFileSelection } from "./result-selection-validation";

export type StudentResultDraftView = {
  id: string;
  appointmentId: string;
  resultType: "LABORATORY" | "PHYSICAL_EXAM";
  status: "DRAFT" | "FINALIZED";
  basedOnSubmissionId: string | null;
  fileCount: number;
  totalBytes: number;
  administratorReplacementReason: string | null;
  files: Array<{ id: string; originalFilename: string; byteSize: number }>;
};

type Confirmation = "finalize" | "cancel-edit" | "submit-changes" | null;

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const staleEditMessage = "Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.";

function errorMessage(payload: unknown, fallback: string) {
  if (
    typeof payload === "object"
    && payload !== null
    && "error" in payload
    && typeof payload.error === "object"
    && payload.error !== null
    && "message" in payload.error
    && typeof payload.error.message === "string"
  ) {
    if (
      "code" in payload.error
      && payload.error.code === "RESULT_EDIT_STALE"
    ) return staleEditMessage;
    return payload.error.message;
  }
  return fallback;
}

export function ResultDraftManager({ draft }: { draft: StudentResultDraftView }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const editing = draft.status === "DRAFT" && draft.basedOnSubmissionId !== null;
  const pending = pendingAction !== null;
  const selection = validateResultFileSelection(selectedFiles, {
    currentFileCount: draft.fileCount,
    currentTotalBytes: draft.totalBytes,
  });

  async function mutate(
    action: string,
    request: () => Promise<Response>,
    fallback: string,
    onSuccess?: () => void,
  ) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPendingAction(action);
    setError(undefined);
    try {
      const response = await request();
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        setError(errorMessage(payload, fallback));
        return;
      }
      onSuccess?.();
      router.refresh();
    } catch {
      setError(fallback);
    } finally {
      inFlightRef.current = false;
      setPendingAction(null);
    }
  }

  function clearSelection() {
    setSelectedFiles([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFiles(event.currentTarget.files ? Array.from(event.currentTarget.files) : []);
    setError(undefined);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection.canUpload || inFlightRef.current) return;
    const form = new FormData();
    form.append("submissionId", draft.id);
    for (const file of selectedFiles) form.append("file", file);
    await mutate(
      "upload",
      () => fetch(`/api/student/result-submissions/${draft.appointmentId}/files`, {
        method: "POST",
        body: form,
      }),
      selectedFiles.length === 1
        ? "Unable to upload this file."
        : "Unable to upload these files.",
      clearSelection,
    );
  }

  async function removeFile(fileId: string) {
    await mutate(
      `remove:${fileId}`,
      () => fetch(
        `/api/student/result-submissions/${draft.appointmentId}/files/${fileId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ submissionId: draft.id }),
        },
      ),
      "Unable to remove this file.",
    );
  }

  async function startEditing() {
    await mutate(
      "edit",
      () => fetch(`/api/student/result-submissions/${draft.appointmentId}/edit`, {
        method: "POST",
      }),
      "Unable to start editing this submission.",
    );
  }

  async function finalize() {
    await mutate(
      "finalize",
      () => fetch(`/api/student/result-submissions/${draft.appointmentId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: draft.id }),
      }),
      "Unable to submit this result.",
      () => setConfirmation(null),
    );
  }

  async function cancelEditing() {
    await mutate(
      "cancel-edit",
      () => fetch(`/api/student/result-submissions/${draft.appointmentId}/edit`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: draft.id }),
      }),
      "Unable to cancel editing.",
      () => setConfirmation(null),
    );
  }

  async function submitChanges() {
    await mutate(
      "submit-changes",
      () => fetch(`/api/student/result-submissions/${draft.appointmentId}/submit-changes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: draft.id }),
      }),
      "Unable to submit these changes.",
      () => setConfirmation(null),
    );
  }

  return (
    <div className="grid gap-5">
      <Card className="p-5">
        {draft.status === "FINALIZED" ? (
          <>
            <p className="font-bold">Submitted</p>
            <p className="mt-1 text-sm text-muted">
              {draft.fileCount} {draft.fileCount === 1 ? "file" : "files"} · {formatBytes(draft.totalBytes)}
            </p>
          </>
        ) : (
          <>
            <p className="font-bold">
              {editing
                ? "Editing submission"
                : `${draft.resultType === "LABORATORY" ? "Laboratory" : "Physical Examination"} draft`}
            </p>
            <p className="mt-1 text-sm text-muted">
              {draft.fileCount}/10 files · {formatBytes(draft.totalBytes)}/50 MB
            </p>
            {editing ? (
              <p className="mt-2 text-sm text-muted">
                Your currently submitted result remains official until you submit these changes.
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted">
                Inactive drafts expire after seven days. Add or remove a file to keep this draft active.
              </p>
            )}
          </>
        )}
      </Card>

      {draft.administratorReplacementReason !== null ? (
        <Alert tone="warning">
          <p className="font-semibold">An administrator requested a replacement.</p>
          <p className="mt-1">{draft.administratorReplacementReason}</p>
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {draft.status === "DRAFT" ? (
        <form onSubmit={upload} className="grid gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Input
              ref={inputRef}
              aria-label="Choose result files"
              type="file"
              accept={RESULT_FILE_ACCEPT}
              multiple
              disabled={pending}
              onChange={selectFiles}
              className="min-w-0 flex-1"
            />
            <Button type="submit" disabled={pending || !selection.canUpload}>
              <span aria-live="polite">
                {pendingAction === "upload"
                  ? `Uploading ${selectedFiles.length} ${selectedFiles.length === 1 ? "file" : "files"}...`
                  : "Upload files"}
              </span>
            </Button>
            {selection.rows.length > 0 ? (
              <Button type="button" variant="secondary" disabled={pending} onClick={clearSelection}>
                Clear selection
              </Button>
            ) : null}
          </div>
          {selection.batchError ? <Alert tone="danger">{selection.batchError}</Alert> : null}
          {selection.rows.length > 0 ? (
            <ul aria-label="Selected result files" className="grid gap-2">
              {selection.rows.map((row, index) => (
                <li
                  key={`${row.filename}-${row.byteSize}-${index}`}
                  className="rounded-xl border border-line bg-canvas px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-all font-semibold text-ink">{row.filename}</span>
                    <span className="text-xs text-muted">{formatBytes(row.byteSize)}</span>
                  </div>
                  {row.error ? (
                    <p role="alert" className="mt-1 text-sm text-red-800">{row.error}</p>
                  ) : (
                    <p className="mt-1 text-xs text-emerald-800">Ready to upload</p>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </form>
      ) : null}

      <ul aria-label={draft.status === "FINALIZED" ? "Submitted files" : "Draft files"} className="grid gap-3">
        {draft.files.map((file) => (
          <li key={file.id}>
            <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="break-all font-semibold">{file.originalFilename}</p>
                <p className="text-xs text-muted">{formatBytes(file.byteSize)}</p>
              </div>
              {draft.status === "DRAFT" ? (
                <Button
                  variant="secondary"
                  disabled={pending}
                  aria-label={`Remove ${file.originalFilename}`}
                  onClick={() => void removeFile(file.id)}
                >
                  {pendingAction === `remove:${file.id}` ? "Removing..." : "Remove"}
                </Button>
              ) : (
                <a
                  href={`/api/student/result-files/${file.id}`}
                  aria-label={`Download ${file.originalFilename}`}
                  className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold"
                >
                  Download
                </a>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {draft.status === "FINALIZED" ? (
        <Button disabled={pending} onClick={() => void startEditing()}>
          {pendingAction === "edit" ? "Starting edit..." : "Edit submission"}
        </Button>
      ) : editing ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => setConfirmation("cancel-edit")}
          >
            Cancel editing
          </Button>
          <Button
            variant="accent"
            disabled={pending || draft.fileCount === 0}
            onClick={() => setConfirmation("submit-changes")}
          >
            Submit changes
          </Button>
        </div>
      ) : draft.fileCount > 0 ? (
        <Button
          variant="accent"
          disabled={pending}
          onClick={() => setConfirmation("finalize")}
        >
          Final submit
        </Button>
      ) : null}

      <ConfirmDialog
        open={confirmation === "finalize"}
        title="Submit this result?"
        description="These files will become your submitted result. You can edit your submission later if corrections are needed."
        confirmLabel="Submit result"
        pending={pendingAction === "finalize"}
        pendingLabel="Submitting result..."
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void finalize()}
      />
      <ConfirmDialog
        open={confirmation === "cancel-edit"}
        title="Cancel editing?"
        description="Discard your changes? Your currently submitted result will remain unchanged."
        confirmLabel="Discard changes"
        pending={pendingAction === "cancel-edit"}
        pendingLabel="Discarding changes..."
        danger
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void cancelEditing()}
      />
      <ConfirmDialog
        open={confirmation === "submit-changes"}
        title="Submit these changes?"
        description="Your edited files will replace your currently submitted result."
        confirmLabel="Submit changes"
        pending={pendingAction === "submit-changes"}
        pendingLabel="Submitting changes..."
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void submitChanges()}
      />
    </div>
  );
}
