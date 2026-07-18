import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import {
  listStudentNotifications,
  markStudentNotificationRead,
} from "@/server/services/student-notifications.service";

const readSchema = z.object({ notificationId: z.string().uuid() });

export async function GET() {
  try {
    const student = await requireStudent();
    return dataResponse(await listStudentNotifications(student.studentNumber));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const student = await requireStudent();
    const { notificationId } = readSchema.parse(await request.json());
    return dataResponse({
      success: await markStudentNotificationRead(student.studentNumber, notificationId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
