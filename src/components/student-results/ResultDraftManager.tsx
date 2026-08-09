"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
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
  officialSubmission: {
    id: string;
    files: Array<{ id: string; originalFilename: string; byteSize: number }>;
    fileCount: number;
    totalBytes: number;
  } | null;
};

type Confirmation = "finalize" | "cancel-edit" | "submit-changes" | null;
type MutationState = {
  action: string;
  requestRevision: string;
  awaitingAuthoritativeProps: boolean;
  uploadCount: number;
};

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const staleEditMessage = "Your submission was changed by an administrator while you were editing it. Your unfinished edit can no longer be submitted. Review the reason and upload the requested replacement.";

function responseError(payload: unknown) {
  if (
    typeof payload === "object"
    && payload !== null
    && "error" in payload
    && typeof payload.error === "object"
    && payload.error !== null
  ) {
    return {
      code: "code" in payload.error && typeof payload.error.code === "string"
        ? payload.error.code
        : null,
      message: "message" in payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : null,
    };
  }
  return null;
}

function draftRevision(draft: StudentResultDraftView) {
  return JSON.stringify([
    draft.id,
    draft.status,
    draft.basedOnSubmissionId,
    draft.fileCount,
    draft.totalBytes,
    draft.administratorReplacementReason,
    draft.files.map((file) => [file.id, file.originalFilename, file.byteSize]),
    draft.officialSubmission === null
      ? null
      : [
        draft.officialSubmission.id,
        draft.officialSubmission.fileCount,
        draft.officialSubmission.totalBytes,
        draft.officialSubmission.files.map((file) => [
          file.id,
          file.originalFilename,
          file.byteSize,
        ]),
      ],
  ]);
}

export function ResultDraftManager({ draft }: { draft: StudentResultDraftView }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const [mutationState, setMutationState] = useState<MutationState | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const editing = draft.status === "DRAFT" && draft.basedOnSubmissionId !== null;
  const revision = draftRevision(draft);
  const authoritativeRevisionArrived = mutationState?.awaitingAuthoritativeProps === true
    && mutationState.requestRevision !== revision;
  const pendingAction = mutationState !== null && !authoritativeRevisionArrived
    ? mutationState.action
    : null;
  const pending = pendingAction !== null;
  const selection = validateResultFileSelection(selectedFiles, {
    currentFileCount: draft.fileCount,
    currentTotalBytes: draft.totalBytes,
  });

  useEffect(() => {
    if (authoritativeRevisionArrived) inFlightRef.current = false;
  }, [authoritativeRevisionArrived]);

  async function mutate(
    action: string,
    request: () => Promise<Response>,
    fallback: string,
    onSuccess?: () => void,
    uploadCount = 0,
  ) {
    if (inFlightRef.current) return;
    const requestRevision = revision;
    let keepLockedForRefresh = false;
    inFlightRef.current = true;
    const activeMutation = {
      action,
      requestRevision,
      awaitingAuthoritativeProps: false,
      uploadCount,
    };
    setMutationState(activeMutation);
    setError(undefined);
    try {
      const response = await request();
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        const apiError = responseError(payload);
        if (apiError?.code === "RESULT_EDIT_STALE") {
          keepLockedForRefresh = true;
          setError(staleEditMessage);
          setConfirmation(null);
          setMutationState({ ...activeMutation, awaitingAuthoritativeProps: true });
          router.refresh();
          return;
        }
        setError(apiError?.message ?? fallback);
        return;
      }
      onSuccess?.();
      keepLockedForRefresh = true;
      setMutationState({ ...activeMutation, awaitingAuthoritativeProps: true });
      router.refresh();
    } catch {
      setError(fallback);
    } finally {
      if (!keepLockedForRefresh) {
        inFlightRef.current = false;
        setMutationState(null);
      }
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
      selectedFiles.length,
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

      {editing && draft.officialSubmission !== null ? (
        <Card className="grid gap-3 p-5">
          <div>
            <p className="font-bold">Current submitted result</p>
            <p className="mt-1 text-sm text-muted">
              {draft.officialSubmission.fileCount} {draft.officialSubmission.fileCount === 1 ? "file" : "files"}
              {" · "}{formatBytes(draft.officialSubmission.totalBytes)}
            </p>
          </div>
          <ul aria-label="Current submitted files" className="grid gap-3">
            {draft.officialSubmission.files.map((file) => (
              <li key={file.id} className="rounded-xl border border-line bg-canvas p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="break-all font-semibold">{file.originalFilename}</p>
                    <p className="text-xs text-muted">{formatBytes(file.byteSize)}</p>
                  </div>
                  <a
                    href={`/api/student/result-files/${file.id}`}
                    aria-label={`Download ${file.originalFilename}`}
                    className="inline-flex h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold"
                  >
                    Download
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

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
                  ? `Uploading ${mutationState?.uploadCount ?? 0} ${mutationState?.uploadCount === 1 ? "file" : "files"}...`
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
