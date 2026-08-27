import { AppError } from "@/lib/errors";

export function schedulingWorkflowRetiredError() {
  return new AppError(
    "SCHEDULING_WORKFLOW_RETIRED",
    "This scheduling workflow has been retired. Use Schedule Imports to create and publish student schedules.",
    410,
  );
}

export function studentLookupRetiredError() {
  return new AppError(
    "STUDENT_LOOKUP_RETIRED",
    "Public student schedule lookup has been retired. Sign in to the Student Portal to view your schedule.",
    410,
  );
}
