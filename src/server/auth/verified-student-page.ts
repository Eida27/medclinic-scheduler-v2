import "server-only";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { studentVerificationHref } from "@/lib/student-verification-return";
import { requireVerifiedStudent } from "./current-student";

export async function requireVerifiedStudentPage(returnTo?: unknown) {
  try {
    return await requireVerifiedStudent();
  } catch (error) {
    if (error instanceof AppError && error.code === "STUDENT_EMAIL_VERIFICATION_REQUIRED") {
      redirect(returnTo === undefined ? "/student/email-verification" : studentVerificationHref(returnTo));
    }
    redirect("/student/login");
  }
}
