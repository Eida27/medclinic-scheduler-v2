export type LaboratoryTestCode = "CBC" | "URINE" | "STOOL" | "XRAY";
export type PeLaboratoryMode = "STANDARD" | "FOURTH_YEAR_OJT" | "FIRST_YEAR_EXTERNAL";

export type LaboratoryCompletionPolicy = {
  mode: PeLaboratoryMode;
  manualTestCodes: LaboratoryTestCode[];
  peConfirmedTestCodes: LaboratoryTestCode[];
  externalProvider: "Iloilo Mission Hospital" | null;
};

export type PeLaboratoryReadiness = {
  laboratoryAppointmentId: string;
  laboratoryCompleted: boolean;
  readyForPe: boolean;
  missingManualTestCodes: LaboratoryTestCode[];
  completionPolicy: LaboratoryCompletionPolicy;
};
