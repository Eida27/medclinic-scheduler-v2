"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

type Entry = {
  id: string;
  code?: string;
  name: string;
  collegeId?: string;
  collegeName?: string;
  rankOrder?: number;
  isActive: boolean;
};

type ReferenceLabel = "college" | "program" | "priority group";

type DeleteTarget = {
  endpoint: string;
  entry: Entry;
  typeLabel: ReferenceLabel;
};

type ReferenceDataManagerProps = {
  colleges: Entry[];
  programs: Entry[];
  priorities: Entry[];
};

function entryLabel(entry: Entry) {
  return entry.code ? `${entry.code} · ${entry.name}` : entry.name;
}

export function ReferenceDataManager({
  colleges,
  programs,
  priorities,
}: ReferenceDataManagerProps) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [deleting, setDeleting] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>, endpoint: string) {
    event.preventDefault();
    setError(undefined);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body: Record<string, string | number> = Object.fromEntries(form.entries()) as Record<string, string>;
    if (body.rankOrder) body.rankOrder = Number(body.rankOrder);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message);
      return;
    }
    formElement.reset();
    router.refresh();
  }

  async function remove() {
    if (!deleteTarget) return;

    setDeleting(true);
    setError(undefined);
    try {
      const response = await fetch(deleteTarget.endpoint, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: deleteTarget.entry.id }),
      });
      const payload = await response.json();
      setDeleteTarget(undefined);
      if (!response.ok) {
        setError(payload.error?.message ?? "The reference value could not be deleted.");
        return;
      }
      router.refresh();
    } catch {
      setDeleteTarget(undefined);
      setError("The reference value could not be deleted.");
    } finally {
      setDeleting(false);
    }
  }

  function requestDelete(entry: Entry, endpoint: string, typeLabel: ReferenceLabel) {
    setError(undefined);
    setDeleteTarget({ endpoint, entry, typeLabel });
  }

  return (
    <div className="grid gap-6">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardTitle>Colleges</CardTitle>
          <form onSubmit={(event) => create(event, "/api/colleges")} className="mt-4 grid gap-3">
            <Input name="code" placeholder="Code" required />
            <Input name="name" placeholder="College name" required />
            <Button type="submit">Add college</Button>
          </form>
          <List
            entries={colleges}
            deleting={deleting}
            onDelete={(entry) => requestDelete(entry, "/api/colleges", "college")}
          />
        </Card>

        <Card>
          <CardTitle>Programs</CardTitle>
          <form onSubmit={(event) => create(event, "/api/programs")} className="mt-4 grid gap-3">
            <Select name="collegeId" required>
              <option value="">College</option>
              {colleges.filter((entry) => entry.isActive).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </Select>
            <Input name="code" placeholder="Code" required />
            <Input name="name" placeholder="Program name" required />
            <Button type="submit">Add program</Button>
          </form>
          <List
            entries={programs}
            deleting={deleting}
            onDelete={(entry) => requestDelete(entry, "/api/programs", "program")}
          />
        </Card>

        <Card>
          <CardTitle>Priority groups</CardTitle>
          <form onSubmit={(event) => create(event, "/api/priority-groups")} className="mt-4 grid gap-3">
            <Input name="name" placeholder="Group name" required />
            <Input name="rankOrder" type="number" min="1" placeholder="Rank" required />
            <Button type="submit">Add priority</Button>
          </form>
          <List
            entries={priorities}
            deleting={deleting}
            onDelete={(entry) => requestDelete(entry, "/api/priority-groups", "priority group")}
          />
        </Card>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.typeLabel ?? "reference"}?`}
        description={deleteTarget
          ? `Delete “${entryLabel(deleteTarget.entry)}”? This action cannot be undone.`
          : ""}
        confirmLabel={`Delete ${deleteTarget?.typeLabel ?? "reference"}`}
        pendingLabel="Deleting..."
        pending={deleting}
        danger
        onCancel={() => setDeleteTarget(undefined)}
        onConfirm={remove}
      />
    </div>
  );
}

function List({
  entries,
  deleting,
  onDelete,
}: {
  entries: Entry[];
  deleting: boolean;
  onDelete: (entry: Entry) => void;
}) {
  return (
    <div className="mt-5 divide-y divide-line">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between gap-3 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-bold text-ink">{entryLabel(entry)}</p>
            <p className="text-xs text-muted">
              {entry.collegeName ?? (entry.rankOrder ? `Priority ${entry.rankOrder}` : "")}
              {!entry.isActive ? " · Inactive" : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="danger"
            aria-label={`Delete ${entryLabel(entry)}`}
            disabled={deleting}
            onClick={() => onDelete(entry)}
          >
            Delete
          </Button>
        </div>
      ))}
    </div>
  );
}
