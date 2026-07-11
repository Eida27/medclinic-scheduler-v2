import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import {
  importStudentScheduleCsv,
  listScheduleImports,
} from "@/server/services/schedule-imports.service";

export async function GET() {
  try {
    const user = await requireUser(["ADMIN"]);
    return dataResponse(await listScheduleImports(user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(["ADMIN"]);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError(
        "CSV_IMPORT_INVALID",
        "Choose a CSV file to import.",
        422,
        { file: ["Choose a CSV file to import."] },
      );
    }

    const result = await importStudentScheduleCsv({
      fileName: file.name,
      fileSize: file.size,
      contents: new Uint8Array(await file.arrayBuffer()),
      importName: form.get("importName"),
      priorityGroupId: form.get("priorityGroupId"),
      submittedByName: form.get("submittedByName"),
      description: form.get("description"),
    }, user);
    return dataResponse(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
