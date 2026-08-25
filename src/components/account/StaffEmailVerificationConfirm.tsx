"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
export function StaffEmailVerificationConfirm({ token }: { token: string }) {
  const [state, setState] = useState<"pending" | "success" | "error">("pending"); const [message, setMessage] = useState("Verifying your staff email...");
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/staff/email-verification/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const payload = await response.json();
        if (!response.ok) {
          setState("error");
          setMessage(payload.error?.message ?? "This verification link is invalid or expired.");
          return;
        }
        setState("success");
        setMessage(payload.data?.mustChangePassword
          ? "Email verified. Return to your signed-in browser to replace the temporary password."
          : "Email verified. You can return to MedClinic.");
      } catch {
        setState("error");
        setMessage("Unable to verify your email right now. Check your connection and open the verification link again.");
      }
    })();
  }, [token]);
  return <div className="grid gap-5"><Alert tone={state === "error" ? "danger" : state === "success" ? "success" : "info"}>{message}</Alert>{state !== "pending" ? <Link className="inline-flex h-11 items-center justify-center rounded-xl bg-cpu-navy px-4 text-sm font-semibold text-white" href="/login">Continue to Login</Link> : null}</div>;
}
