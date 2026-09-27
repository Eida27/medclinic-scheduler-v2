"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

type Physician = {
  id: string;
  version: number;
  active: boolean;
  displayName: string;
  licenseNumber: string;
  specialty: string | null;
};

export function PhysicianProfiles({ profiles }: { profiles: Physician[] }) {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>, profile?: Physician) {
    event.preventDefault();
    if (busyRef.current) return;
    const formElement = event.currentTarget;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const form = new FormData(formElement);
      if (profile) form.set("expectedVersion", String(profile.version));
      const response = await fetch(profile
        ? `/api/settings/medical-certificate-physicians/${profile.id}`
        : "/api/settings/medical-certificate-physicians", {
        method: profile ? "PATCH" : "POST",
        body: form,
      });
      const payload = await readApiPayload<Physician>(response);
      if (!response.ok) throw new Error(apiErrorMessage(payload, "Unable to save the physician profile."));
      if (!profile) formElement.reset();
      setSuccess(`Saved ${payload?.data?.displayName ?? "physician"} profile revision.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the physician profile.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function fields(profile?: Physician) {
    return <>
      <label className="grid gap-1 text-sm font-semibold">Physician name
        <input name="displayName" required maxLength={200} defaultValue={profile?.displayName} className="rounded-lg border border-line p-2" />
      </label>
      <label className="grid gap-1 text-sm font-semibold">License number
        <input name="licenseNumber" required maxLength={60} defaultValue={profile?.licenseNumber} className="rounded-lg border border-line p-2" />
      </label>
      <label className="grid gap-1 text-sm font-semibold">Specialty
        <input name="specialty" maxLength={120} defaultValue={profile?.specialty ?? ""} className="rounded-lg border border-line p-2" />
      </label>
      <label className="grid gap-1 text-sm font-semibold">Authorized signature {profile ? "(optional replacement)" : "(required)"}
        <input name="signature" type="file" accept="image/png,image/jpeg" required={!profile} className="rounded-lg border border-line p-2" />
      </label>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input name="active" type="checkbox" value="true" defaultChecked={profile?.active ?? true} /> Active for new certificates
      </label>
    </>;
  }

  return <div className="grid gap-6">
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {success ? <Alert tone="success">{success}</Alert> : null}
    <section className="rounded-2xl border border-line bg-surface p-6">
      <h2 className="mb-4 text-lg font-bold">Add physician</h2>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        {fields()}
        <Button type="submit" disabled={busy}>Save physician</Button>
      </form>
    </section>
    {profiles.map((profile) => <section key={`${profile.id}-${profile.version}`} className="rounded-2xl border border-line bg-surface p-6">
      <h2 className="mb-1 text-lg font-bold">{profile.displayName}</h2>
      <p className="mb-4 text-sm text-muted">Revision {profile.version} · {profile.active ? "Active" : "Inactive"}</p>
      <form className="grid gap-4" onSubmit={(event) => void submit(event, profile)}>
        {fields(profile)}
        <Button type="submit" disabled={busy}>Save new revision</Button>
      </form>
    </section>)}
  </div>;
}
