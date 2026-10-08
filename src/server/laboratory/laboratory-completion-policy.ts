import { AppError } from "@/lib/errors";
import { requiredLaboratoryTests } from "./laboratory-requirements";
import type { LaboratoryCompletionPolicy } from "@/shared/laboratory-completion";

export function resolveLaboratoryCompletionPolicy(context: {
  yearLevel: number | null | undefined;
  schedulingCategory: string | null | undefined;
  isOvpsaFirstYear: boolean;
}): LaboratoryCompletionPolicy {
  const tests = requiredLaboratoryTests(context);
  if ((context.yearLevel === 1) !== context.isOvpsaFirstYear) {
    throw new AppError("LABORATORY_PROVENANCE_MISSING",
      "First-Year Laboratory requires valid OVPSA provenance and an immutable first-year snapshot.", 409);
  }
  if (context.isOvpsaFirstYear) {
    return { mode: "FIRST_YEAR_EXTERNAL", manualTestCodes: [], peConfirmedTestCodes: tests,
      externalProvider: "Iloilo Mission Hospital" };
  }
  if (context.yearLevel === 4 && context.schedulingCategory === "OJT") {
    return { mode: "FOURTH_YEAR_OJT", manualTestCodes: ["CBC", "URINE", "STOOL"],
      peConfirmedTestCodes: ["XRAY"], externalProvider: "Iloilo Mission Hospital" };
  }
  return { mode: "STANDARD", manualTestCodes: tests, peConfirmedTestCodes: [], externalProvider: null };
}
