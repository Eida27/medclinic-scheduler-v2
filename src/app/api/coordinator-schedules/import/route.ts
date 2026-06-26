import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { importCoordinatorScheduleCsv } from "@/server/services/coordinator-schedules.service";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
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

    const result = await importCoordinatorScheduleCsv({
      fileName: file.name,
      fileSize: file.size,
      contents: await file.text(),
      clinicCode: form.get("clinicCode"),
      batchName: form.get("batchName"),
      priorityGroupId: form.get("priorityGroupId"),
      submittedByName: form.get("submittedByName"),
      description: form.get("description"),
    }, user);
    return dataResponse(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
