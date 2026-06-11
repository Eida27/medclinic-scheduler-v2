"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function BatchActions({ batchId, status, isAdmin }: { batchId: string; status: string; isAdmin: boolean }) {
  const router = useRouter(); const [pending, setPending] = useState<string>(); const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string }>(); const [overrideReason, setOverrideReason] = useState("");
  async function action(kind: "validate" | "generate") { setPending(kind); setMessage(undefined); const response = await fetch(kind === "validate" ? "/api/coordinator-schedules/validate" : "/api/appointments/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId, overrideReason: overrideReason || undefined }) }); const payload = await response.json(); if (!response.ok) setMessage({ tone: "danger", text: payload.error?.message ?? "Action failed." }); else { setMessage({ tone: "success", text: kind === "validate" ? "Validation completed." : "Draft appointments generated." }); router.refresh(); } setPending(undefined); }
  if (["PUBLISHED", "CANCELLED"].includes(status)) return null;
  return <div className="grid gap-3">{message ? <Alert tone={message.tone}>{message.text}</Alert> : null}<div className="flex flex-wrap gap-3"><Button variant="secondary" onClick={() => action("validate")} disabled={Boolean(pending) || status === "GENERATED"}>{pending === "validate" ? "Validating..." : "Validate batch"}</Button><Button onClick={() => action("generate")} disabled={Boolean(pending) || status === "GENERATED"}>{pending === "generate" ? "Generating..." : "Generate drafts"}</Button></div>{isAdmin ? <Input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Admin capacity override reason, when required" /> : null}</div>;
}
