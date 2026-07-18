"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type Notification = {
  id: string;
  title: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
};

export function NotificationList({ items }: { items: Notification[] }) {
  const router = useRouter();
  if (!items.length) return <Card className="p-5 text-sm text-muted">No notifications yet.</Card>;
  return (
    <div className="grid gap-3">
      {items.map((item) => (
        <Card key={item.id} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-bold">{item.title}</h2>
              <p className="mt-1 text-sm text-muted-strong">{item.message}</p>
              <p className="mt-2 text-xs text-muted">{new Date(item.createdAt).toLocaleString()}</p>
            </div>
            {!item.readAt ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  await fetch("/api/student/notifications", {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ notificationId: item.id }),
                  });
                  router.refresh();
                }}
              >
                Mark read
              </Button>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
