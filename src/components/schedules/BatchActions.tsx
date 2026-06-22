"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function BatchActions({ batchId, status, isAdmin }: { batchId: string; status: string; isAdmin: boolean }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string }>(); const [overrideReason, setOverrideReason] = useState("");
  async function generate() { setPending(true); setMessage(undefined); const response = await fetch("/api/appointments/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId, overrideReason: overrideReason || undefined }) }); const payload = await response.json(); if (!response.ok) setMessage({ tone: "danger", text: payload.error?.message ?? "Action failed." }); else setMessage({ tone: "success", text: "Draft appointments generated." }); router.refresh(); setPending(false); }
  if (["PUBLISHED", "CANCELLED"].includes(status)) return null;
  return <div className="grid gap-3">{message ? <Alert tone={message.tone}>{message.text}</Alert> : null}<div className="flex flex-wrap gap-3"><Button onClick={generate} disabled={pending || status === "GENERATED"}>{pending ? "Generating..." : "Generate drafts"}</Button></div>{isAdmin ? <Input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Admin capacity override reason, when required" /> : null}</div>;
}
