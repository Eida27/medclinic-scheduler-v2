import "server-only";
import { cookies } from "next/headers";
import { AppError } from "@/lib/errors";
import { findActiveStudentIdentity } from "@/server/repositories/student-portal.repository";
import { STUDENT_SESSION_COOKIE, verifyStudentSessionToken } from "./student-session";

export async function requireStudent() {
  const token = (await cookies()).get(STUDENT_SESSION_COOKIE)?.value;
  if (!token) throw new AppError("UNAUTHENTICATED", "Please sign in to continue.", 401);
  try {
    const session = await verifyStudentSessionToken(token);
    const student = await findActiveStudentIdentity(session.studentNumber);
    if (!student) throw new Error("Inactive student");
    return student;
  } catch {
    throw new AppError("UNAUTHENTICATED", "Please sign in to continue.", 401);
  }
}

export async function optionalStudent() {
  try {
    return await requireStudent();
  } catch {
    return null;
  }
}
