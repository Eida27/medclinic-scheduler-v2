"use client";

import Link from "next/link";
import { useState } from "react";

export function EmailVerificationReminder() {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <aside className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cpu-gold/50 bg-cpu-gold/10 p-4 text-sm">
      <p><Link className="font-bold underline" href="/student/email-verification">Verify an email</Link> to receive optional schedule alerts.</p>
      <button
        type="button"
        className="font-semibold underline"
        onClick={() => setVisible(false)}
      >
        Dismiss
      </button>
    </aside>
  );
}
