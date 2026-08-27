type AutomaticReplacementBoundsInput = {
  replacementType: "PAIR" | "PHYSICAL_EXAM_ONLY";
  originalWindowStart: string;
  manilaToday: string;
  cycleClosingDate: string;
  laboratoryDate?: string;
};

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function resolveAutomaticReplacementBounds(input: AutomaticReplacementBoundsInput) {
  const candidates = [input.originalWindowStart, addDays(input.manilaToday, 1)];
  if (input.replacementType === "PHYSICAL_EXAM_ONLY") {
    if (!input.laboratoryDate) {
      throw new Error("Physical Examination replacement bounds require a Laboratory date.");
    }
    candidates.push(addDays(input.laboratoryDate, 1));
  }
  return {
    lowerBound: candidates.sort().at(-1)!,
    upperBound: input.cycleClosingDate,
  };
}
