import { z } from "zod";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { requestStudentEmailVerification } from "@/server/services/student-email.service";

const schema = z.object({ email: z.string().trim().email().max(254) });

export async function POST(request: Request) {
  try {
    const student = await requireStudent();
    const input = schema.parse(await request.json());
    await requestStudentEmailVerification(student.studentNumber, input.email);
    return dataResponse({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
