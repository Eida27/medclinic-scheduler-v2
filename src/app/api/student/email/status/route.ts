import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentEmailVerificationStatus } from "@/server/services/student-email.service";

export async function GET() {
  try {
    const student = await requireStudent();
    return dataResponse(await getStudentEmailVerificationStatus(student.studentNumber));
  } catch (error) {
    return errorResponse(error);
  }
}
