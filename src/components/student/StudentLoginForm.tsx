"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function StudentLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const fallback = "Unable to sign in. Check your connection and try again.";
    try {
      const response = await fetch("/api/student-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          studentNumber: form.get("studentNumber"),
          dateOfBirth: form.get("dateOfBirth"),
          middleName: form.get("middleName"),
        }),
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        setError(apiErrorMessage(payload, fallback));
        return;
      }
      router.replace("/student");
      router.refresh();
    } catch {
      setError(fallback);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
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
      <Field label="Middle Name">
        <Input
          name="middleName"
          type="text"
          autoComplete="additional-name"
          required
        />
      </Field>
      <Button type="submit" className="mt-1 w-full" disabled={pending}>
        {pending ? "Signing in..." : "Student sign in"}
      </Button>
    </form>
  );
}
