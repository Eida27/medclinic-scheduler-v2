"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function StudentLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/student-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        studentNumber: form.get("studentNumber"),
        dateOfBirth: form.get("dateOfBirth"),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Unable to sign in.");
      setPending(false);
      return;
    }
    router.replace("/student");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Field label="Student Number">
        <Input name="studentNumber" autoComplete="username" placeholder="00-0000-00" required />
      </Field>
      <Field label="Date of Birth">
        <Input name="dateOfBirth" type="date" autoComplete="bday" required />
      </Field>
      <Button type="submit" className="mt-1 w-full" disabled={pending}>
        {pending ? "Signing in..." : "Student sign in"}
      </Button>
    </form>
  );
}
