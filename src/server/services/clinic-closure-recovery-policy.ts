import type {
  ClinicCalendarCategory,
  ClinicClosureRecoveryMode,
  ClinicManualCaseReason,
} from "@/types/clinic-calendar";

type ServiceType = "LABORATORY" | "PHYSICAL_EXAM";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export type ClinicClosureRecoveryDecision =
  | "AUTO_RECOVERY_ELIGIBLE"
  | "MANUAL_RESOLUTION_REQUIRED";

export interface ClinicClosureSafetyReason {
  reasonCode: ClinicManualCaseReason;
  reasonMessage: string;
}

export interface ClinicClosureRecoveryPolicyInput {
  category: ClinicCalendarCategory;
  policyEffectiveDate: string;
  affectedAppointmentDate: string;
  affectedService: ServiceType;
  recoveryMode: ClinicClosureRecoveryMode;
  isOvpsaControlledLaboratory: boolean;
  safetyReason?: ClinicClosureSafetyReason | null;
}

export interface ClinicClosureRecoveryPolicyDecision {
  decision: ClinicClosureRecoveryDecision;
  noticeDays: number;
  reasonCode: ClinicManualCaseReason | null;
  reasonMessage: string | null;
}

function parseDateOnly(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Expected a date-only value, received ${value}.`);
  }

  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function calculateManilaNoticeDays(
  policyEffectiveDate: string,
  affectedAppointmentDate: string,
): number {
  return Math.round(
    (parseDateOnly(affectedAppointmentDate) - parseDateOnly(policyEffectiveDate))
      / MILLISECONDS_PER_DAY,
  );
}

export function evaluateClosureRecoveryPolicy(
  input: ClinicClosureRecoveryPolicyInput,
): ClinicClosureRecoveryPolicyDecision {
  const noticeDays = calculateManilaNoticeDays(
    input.policyEffectiveDate,
    input.affectedAppointmentDate,
  );

  if (input.category === "EMERGENCY_CLOSURE") {
    return {
      decision: "MANUAL_RESOLUTION_REQUIRED",
      noticeDays,
      reasonCode: "EMERGENCY_CLOSURE",
      reasonMessage: "Emergency closures require administrator review.",
    };
  }

  if (
    input.affectedService === "LABORATORY"
    && input.isOvpsaControlledLaboratory
  ) {
    return {
      decision: "MANUAL_RESOLUTION_REQUIRED",
      noticeDays,
      reasonCode: "OVPSA_LABORATORY_PROTECTED",
      reasonMessage: "OVPSA Laboratory appointments require coordinated batch recovery.",
    };
  }

  if (noticeDays <= 30) {
    return {
      decision: "MANUAL_RESOLUTION_REQUIRED",
      noticeDays,
      reasonCode: "NOTICE_PERIOD_PROTECTED",
      reasonMessage: "Appointments with 30 days or less notice require manual resolution.",
    };
  }

  if (input.safetyReason) {
    return {
      decision: "MANUAL_RESOLUTION_REQUIRED",
      noticeDays,
      ...input.safetyReason,
    };
  }

  if (input.recoveryMode === "MANUAL_ALL") {
    return {
      decision: "MANUAL_RESOLUTION_REQUIRED",
      noticeDays,
      reasonCode: "ADMIN_CHOSE_MANUAL_RECOVERY",
      reasonMessage: "The administrator chose manual recovery for this closure batch.",
    };
  }

  return {
    decision: "AUTO_RECOVERY_ELIGIBLE",
    noticeDays,
    reasonCode: null,
    reasonMessage: null,
  };
}

export interface ClosureRecoveryQueueEntry {
  affectedAppointmentDate: string;
  originalCreatedAt: string;
  originalOrder: number;
  studentNumber: string;
}

export function compareClosureRecoveryQueueEntries(
  left: ClosureRecoveryQueueEntry,
  right: ClosureRecoveryQueueEntry,
): number {
  return left.affectedAppointmentDate.localeCompare(right.affectedAppointmentDate)
    || left.originalCreatedAt.localeCompare(right.originalCreatedAt)
    || left.originalOrder - right.originalOrder
    || left.studentNumber.localeCompare(right.studentNumber);
}
