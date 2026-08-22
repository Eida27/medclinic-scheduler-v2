import "server-only";
import { AppError } from "@/lib/errors";
import { optionalStudent } from "./current-student";
import { requireUser } from "./current-user";

export async function requireAdministrator() {
  try {
    return await requireUser(["ADMIN"]);
  } catch (error) {
    if (error instanceof AppError && error.status === 401 && await optionalStudent()) {
      throw new AppError("FORBIDDEN", "Administrators only.", 403);
    }
    throw error;
  }
}
