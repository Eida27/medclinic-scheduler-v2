import { errorResponse } from "@/lib/api-response";
import { studentLookupRetiredError } from "@/lib/retired-workflows";

export async function GET(request: Request) {
  void request;
  return errorResponse(studentLookupRetiredError());
}
