// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as scheduleImports from "./schedule-imports.service";
import * as appointments from "./appointments.service";
import * as appointmentRepository from "@/server/repositories/appointments.repository";
import * as ovpsaLifecycle from "@/server/ovpsa/ovpsa-first-year.service";
import * as ruleEngine from "@/server/rule-engine";

describe("schedule import public service surface", () => {
  it("exposes atomic scheduling without staged lifecycle methods", () => {
    expect(scheduleImports.acceptAndScheduleImport).toBeTypeOf("function");
    expect(scheduleImports).not.toHaveProperty("importStudentScheduleCsv");
    expect(scheduleImports).not.toHaveProperty("importAndPublishStudentScheduleCsv");
    expect(scheduleImports).not.toHaveProperty("validateScheduleImport");
    expect(scheduleImports).not.toHaveProperty("generateScheduleImport");
    expect(scheduleImports).not.toHaveProperty("publishScheduleImport");
  });

  it("does not expose legacy appointment publication helpers", () => {
    expect(appointments).not.toHaveProperty("publishScheduleBatch");
    expect(appointments).not.toHaveProperty("publishScheduleBatchWithClient");
    expect(appointmentRepository).not.toHaveProperty("publishBatch");
  });

  it("retains only the post-publication First-Year batch lifecycle", () => {
    expect(ovpsaLifecycle.listOvpsaFirstYearBatches).toBeTypeOf("function");
    expect(ovpsaLifecycle.getOvpsaFirstYearBatch).toBeTypeOf("function");
    expect(ovpsaLifecycle.rescheduleOvpsaFirstYearBatch).toBeTypeOf("function");
    expect(ovpsaLifecycle.cancelOvpsaFirstYearBatch).toBeTypeOf("function");
    expect(ovpsaLifecycle).not.toHaveProperty("createOvpsaFirstYearBatch");
    expect(ovpsaLifecycle).not.toHaveProperty("updateOvpsaFirstYearDraft");
    expect(ovpsaLifecycle).not.toHaveProperty("validateOvpsaFirstYearBatch");
    expect(ovpsaLifecycle).not.toHaveProperty("publishOvpsaFirstYearBatch");
  });

  it("exposes only the retained paired and capacity scheduling rules", () => {
    expect(ruleEngine.generatePairedSchedule).toBeTypeOf("function");
    expect(ruleEngine.checkCapacity).toBeTypeOf("function");
    expect(ruleEngine).not.toHaveProperty("generateSchedule");
    expect(ruleEngine).not.toHaveProperty("sortByPriority");
  });
});
