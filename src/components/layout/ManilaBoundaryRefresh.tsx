"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { manilaCalendarDate } from "@/lib/academic-year";

/** Keeps server-scoped current and historical views current across Manila date changes. */
export function ManilaBoundaryRefresh() {
  const router = useRouter();
  const day = useRef<string | null>(null);

  useEffect(() => {
    day.current = manilaCalendarDate(new Date());
    const refreshIfNewDay = () => {
      const nextDay = manilaCalendarDate(new Date());
      if (day.current !== nextDay) {
        day.current = nextDay;
        router.refresh();
      }
    };
    const onFocus = () => {
      day.current = manilaCalendarDate(new Date());
      router.refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    const interval = window.setInterval(refreshIfNewDay, 60_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
