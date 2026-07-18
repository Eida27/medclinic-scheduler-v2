import { redirect } from "next/navigation";
import { NotificationList } from "@/components/student/NotificationList";
import { requireStudent } from "@/server/auth/current-student";
import { listStudentNotifications } from "@/server/services/student-notifications.service";

export default async function StudentNotificationsPage() {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  const notifications = await listStudentNotifications(student.studentNumber);
  return (
    <section>
      <p className="text-sm font-semibold text-muted">{notifications.unreadCount} unread</p>
      <h1 className="mb-6 mt-1 text-3xl font-bold">Notifications</h1>
      <NotificationList items={notifications.items} />
    </section>
  );
}
