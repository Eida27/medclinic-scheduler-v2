import { AppError } from "@/lib/errors";

export function studentLookupRetiredError() {
  return new AppError(
    "STUDENT_LOOKUP_RETIRED",
    "Public student schedule lookup has been retired. Sign in to the Student Portal to view your schedule.",
    410,
  );
}
