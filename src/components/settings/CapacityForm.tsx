"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";

type Setting = {
  clinicCode: string;
  clinicName: string;
  scheduleType: string;
  maxDailyCapacity: number;
};

export function CapacityForm({ settings }: { settings: Setting[] }) {
  const router = useRouter();
  const [pendingByKey, setPendingByKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const clinicCode = String(form.get("clinicCode"));
    const scheduleType = String(form.get("scheduleType"));
    const key = `${clinicCode}:${scheduleType}`;

    setPendingByKey((current) => ({ ...current, [key]: true }));
    setError(undefined);

    try {
      const response = await fetch("/api/settings/capacity", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clinicCode: form.get("clinicCode"),
          scheduleType: form.get("scheduleType"),
          maxDailyCapacity: Number(form.get("maxDailyCapacity")),
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error?.message);
        return;
      }

      router.refresh();
    } finally {
      setPendingByKey((current) => ({ ...current, [key]: false }));
    }
  }

  return (
    <div className="grid gap-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {settings.map((setting) => {
        const key = `${setting.clinicCode}:${setting.scheduleType}`;
        const pending = pendingByKey[key] ?? false;

        return (
          <Card key={key}>
            <form
              onSubmit={submit}
              aria-busy={pending}
              className="grid items-end gap-4 sm:grid-cols-3"
            >
              <input type="hidden" name="clinicCode" value={setting.clinicCode} />
              <input type="hidden" name="scheduleType" value={setting.scheduleType} />
              <div>
                <p className="font-bold text-ink">{setting.clinicName}</p>
                <p className="text-xs text-muted">
                  {setting.scheduleType.replaceAll("_", " ")} daily limit
                </p>
              </div>
              <label className="text-sm font-semibold text-muted-strong">
                Maximum students per day
                <Input
                  name="maxDailyCapacity"
                  type="number"
                  min="1"
                  defaultValue={setting.maxDailyCapacity}
                  disabled={pending}
                />
              </label>
              <Button type="submit" aria-label="Save" disabled={pending}>
                {pending ? <Spinner size="sm" label="Saving capacity" /> : null}
                Save
              </Button>
            </form>
          </Card>
        );
      })}
    </div>
  );
}
