import "server-only";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { requireVerifiedStudent } from "./current-student";

export async function requireVerifiedStudentPage() {
  try {
    return await requireVerifiedStudent();
  } catch (error) {
    if (error instanceof AppError && error.code === "STUDENT_EMAIL_VERIFICATION_REQUIRED") {
      redirect("/student/email-verification");
    }
    redirect("/student/login");
  }
}
