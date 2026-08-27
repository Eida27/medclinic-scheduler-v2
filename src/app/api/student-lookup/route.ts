import { errorResponse } from "@/lib/api-response";
import { studentLookupRetiredError } from "@/lib/retired-workflows";

export async function GET(_request: Request) {
  return errorResponse(studentLookupRetiredError());
}
