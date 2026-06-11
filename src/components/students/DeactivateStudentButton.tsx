"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

export function DeactivateStudentButton({ studentNumber }: { studentNumber: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function deactivate() {
    if (!window.confirm("Deactivate this student record? Existing history will be preserved.")) return;
    setPending(true);
    const response = await fetch(`/api/students/${encodeURIComponent(studentNumber)}`, { method: "DELETE" });
    if (response.ok) { router.push("/students"); router.refresh(); } else { setPending(false); }
  }
  return <Button variant="danger" onClick={deactivate} disabled={pending}>{pending ? "Deactivating..." : "Deactivate"}</Button>;
}
