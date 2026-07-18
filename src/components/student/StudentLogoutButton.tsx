"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function StudentLogoutButton() {
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        await fetch("/api/student-auth/logout", { method: "POST" });
        router.replace("/student/login");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
