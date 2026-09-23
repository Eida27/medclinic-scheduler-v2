import { AppError } from "@/lib/errors";

export type LaboratoryTestCode = "CBC" | "URINE" | "STOOL" | "XRAY";
export const LABORATORY_REQUIREMENTS_VERSION = 1;

export function requiredLaboratoryTests(context: {
  yearLevel: number | null | undefined;
  schedulingCategory: string | null | undefined;
}): LaboratoryTestCode[] {
  const { yearLevel, schedulingCategory } = context;
  if (!Number.isInteger(yearLevel) || yearLevel! < 1 || yearLevel! > 4 ||
      !schedulingCategory || !["REGULAR", "OJT", "TOUR"].includes(schedulingCategory)) {
    throw new AppError("LABORATORY_PROVENANCE_MISSING",
      "The appointment requires a supported academic year level and scheduling category.", 409);
  }
  const required: LaboratoryTestCode[] = ["CBC", "URINE", "STOOL"];
  if (yearLevel === 1 || (yearLevel === 4 && schedulingCategory === "OJT")) required.push("XRAY");
  return required;
}
