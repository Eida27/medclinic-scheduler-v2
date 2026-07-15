import { describe, expect, it } from "vitest";
import { importNameFromFileName } from "./schedule-imports.service";

describe("importNameFromFileName", () => {
  it("derives a normalized name from the CSV filename", () => {
    expect(importNameFromFileName("  First   Semester Schedules.csv  ")).toBe("First Semester Schedules");
  });

  it("uses a stable fallback for filename stems shorter than three characters", () => {
    expect(importNameFromFileName("a.csv")).toBe("Schedule import");
    expect(importNameFromFileName(".csv")).toBe("Schedule import");
  });

  it("truncates names to the database limit by Unicode character", () => {
    const name = importNameFromFileName(`${"😀".repeat(160)}.csv`);

    expect(Array.from(name)).toHaveLength(150);
  });
});
