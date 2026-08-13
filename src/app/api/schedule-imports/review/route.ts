import { dataResponse, errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { reviewFirstYearScheduleImport } from "@/server/services/schedule-imports.service";

export async function POST(request: Request) {
  try {
    const user = await requireUser(["ADMIN", "COORDINATOR"]);
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
    return dataResponse(await reviewFirstYearScheduleImport({
      fileName: file.name,
      fileSize: file.size,
      contents: new Uint8Array(await file.arrayBuffer()),
      importMode: form.get("importMode"),
      studentCategory: form.get("studentCategory"),
      academicYearStart: form.get("academicYearStart"),
      preferredMonth: form.get("preferredMonth"),
      firstYearLaboratoryDate: form.get("firstYearLaboratoryDate"),
    }, user));
  } catch (error) {
    return errorResponse(error);
  }
}
