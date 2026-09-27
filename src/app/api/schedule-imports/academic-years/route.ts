import { manilaCalendarDate } from "@/lib/academic-year";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireUser } from "@/server/auth/current-user";
import { listImportAcademicYears } from "@/server/services/academic-years.service";

export async function GET() {
  try {
    await requireUser(["ADMIN", "COORDINATOR"]);
    const now = new Date();
    const response = dataResponse({ years: await listImportAcademicYears(now), today: manilaCalendarDate(now) });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
