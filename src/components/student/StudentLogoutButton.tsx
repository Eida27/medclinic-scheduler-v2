"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

export function StudentLogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const pendingRef = useRef(false);

  async function logout() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    const fallback = "Unable to sign out. Check your connection and try again.";
    try {
      const response = await fetch("/api/student-auth/logout", { method: "POST" });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        setError(apiErrorMessage(payload, fallback));
        return;
      }
      router.replace("/student/login");
      router.refresh();
    } catch {
      setError(fallback);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="grid gap-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button variant="secondary" onClick={logout} disabled={pending}>
        {pending ? "Signing out..." : "Sign out"}
      </Button>
    </div>
  );
}
