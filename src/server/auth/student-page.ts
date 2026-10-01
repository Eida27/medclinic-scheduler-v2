import "server-only";
import { redirect } from "next/navigation";
import { requireStudent, type CurrentStudent } from "./current-student";

export async function requireStudentPage(): Promise<CurrentStudent> {
  try {
    return await requireStudent();
  } catch {
    redirect("/student/login");
  }
}
