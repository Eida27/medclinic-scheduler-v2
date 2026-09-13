// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { cleanupTestFixtures, insertTestStudent, TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import { setupCapacityFixtureLock, cleanupAndRestoreCapacitySettings, teardownCapacityFixtureLock, type CapacityFixtureLock } from "@/test/capacity-fixture-lifecycle";
import { changeCapacity } from "./appointments.service";
import { acceptAndScheduleImport } from "./schedule-imports.service";

const actor = { userId: TEST_REFERENCE_IDS.adminUser, role: "ADMIN" as const, fullName: "Test", email: "capacity@example.test" };
const input = (maxDailyCapacity: number) => ({ clinicCode: "KABALAKA_CLINIC", scheduleType: "LABORATORY", maxDailyCapacity });
let fixture: CapacityFixtureLock;
async function cleanup() {
  await pool.query("DROP TRIGGER IF EXISTS task4_audit_failure ON audit_logs");
  await pool.query("DROP FUNCTION IF EXISTS task4_audit_failure()");
  await cleanupTestFixtures("99-97%", "%TEST-CAPACITY%", "%TEST-CAPACITY%");
  await pool.query("DELETE FROM audit_logs WHERE action='CAPACITY_UPDATED'");
  await pool.query("DELETE FROM academic_years WHERE start_year=2049");
}
beforeAll(async () => { fixture = await setupCapacityFixtureLock(pool, cleanup); });
beforeEach(async () => {
  await pool.query("INSERT INTO academic_years(start_year,closing_date,created_by,updated_by) VALUES(2049,'2050-07-31',$1,$1)", [actor.userId]);
  await pool.query("UPDATE clinic_capacity_settings SET max_daily_capacity=150,safe_daily_capacity=150");
});
afterEach(async () => { await cleanupAndRestoreCapacitySettings(pool, fixture.originalCapacities, cleanup); });
afterAll(async () => {
  await teardownCapacityFixtureLock(pool, fixture, async () => {
    await cleanup();
    const residue = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM students WHERE student_number LIKE '99-97%') AS students,
      (SELECT COUNT(*)::int FROM appointments WHERE student_number LIKE '99-97%') AS appointments,
      (SELECT COUNT(*)::int FROM schedule_import_groups WHERE source_filename LIKE '%TEST-CAPACITY%') AS imports,
      (SELECT COUNT(*)::int FROM audit_logs WHERE action='CAPACITY_UPDATED') AS audits`);
    expect(residue.rows[0]).toEqual({ students: 0, appointments: 0, imports: 0, audits: 0 });
  });
});
async function load(count: number, status = "PENDING", date = "2049-08-02") {
  for (let index = 0; index < count; index++) {
    const studentNumber = `99-97${String(index).padStart(3, "0")}`;
    await insertTestStudent({ studentNumber, firstName: "Capacity", lastName: "Fixture", yearLevel: 4 });
    await pool.query(`INSERT INTO appointments(clinic_id,student_number,schedule_type,appointment_date,status,is_published,schedule_pair_id,schedule_cycle_start)
      VALUES($1,$2,'LABORATORY',$3,$4,TRUE,gen_random_uuid(),2049)`, [TEST_REFERENCE_IDS.laboratoryClinic, studentNumber, date, status]);
  }
}
async function current() {
  return (await pool.query("SELECT max_daily_capacity FROM clinic_capacity_settings WHERE clinic_id=$1 AND schedule_type='LABORATORY'", [TEST_REFERENCE_IDS.laboratoryClinic])).rows[0].max_daily_capacity;
}
function incoming(student = "99-9799-91") {
  const contents = `Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth\n${student},Capacity,Incoming,Middle,,College of Computer Studies,BSIT,3,2004-01-01`;
  return acceptAndScheduleImport({ fileName: "TEST-CAPACITY.csv", fileSize: Buffer.byteLength(contents), contents,
    studentCategory: "REGULAR", academicYearStart: 2049, preferredMonth: null }, actor);
}
async function waitForQueue(count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = (await pool.query(`SELECT COUNT(*)::int AS count FROM pg_locks
      WHERE locktype='advisory' AND NOT granted AND objid=hashtext('medclinic:schedule-import-queue')::oid`)).rows[0];
    if (row.count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} real clients waiting for the scheduling queue`);
}
const settled = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));

describe("transactional capacity integrity", () => {
  it("rejects 150 to 120 with 130 committed appointments without updating or auditing", async () => {
    await load(130);
    await expect(changeCapacity(input(120), actor.userId)).rejects.toMatchObject({ code: "CAPACITY_COMMITTED_WORKLOAD_CONFLICT", status: 409,
      details: { affectedDates: [{ date: "2049-08-02", count: 130 }], maxDailyCapacity: 120 } });
    expect(await current()).toBe(150);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='CAPACITY_UPDATED'")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM appointments WHERE student_number LIKE '99-97%' AND status='PENDING'")).rowCount).toBe(130);
  });
  it.each(["DRAFT", "COMPLETED", "NO_SHOW"])("counts committed %s workload", async (status) => {
    await load(2, status);
    await expect(changeCapacity(input(1), actor.userId)).rejects.toMatchObject({ status: 409 });
    expect(await current()).toBe(150);
  });
  it("allows safe reductions and increases with atomic audits", async () => {
    await load(2);
    await changeCapacity(input(2), actor.userId);
    expect(await current()).toBe(2);
    await changeCapacity(input(4), actor.userId);
    expect(await current()).toBe(4);
    expect((await pool.query("SELECT 1 FROM audit_logs WHERE action='CAPACITY_UPDATED'")).rowCount).toBe(2);
  });
  it("ignores past workload", async () => {
    await load(2, "COMPLETED", "2020-01-02");
    await changeCapacity(input(1), actor.userId);
    expect(await current()).toBe(1);
  });
  it("rolls capacity back when audit insertion fails", async () => {
    await pool.query(`CREATE FUNCTION task4_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='CAPACITY_UPDATED' THEN RAISE EXCEPTION 'forced capacity audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER task4_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION task4_audit_failure()");
    await expect(changeCapacity(input(120), actor.userId)).rejects.toThrow("forced capacity audit failure");
    expect(await current()).toBe(150);
  });
  it.each([true, false])("serializes a last-slot import and reduction with import first=%s", async (importFirst) => {
    await load(1);
    await pool.query("UPDATE clinic_capacity_settings SET max_daily_capacity=2,safe_daily_capacity=2");
    const blocker = await pool.connect();
    let first: ReturnType<typeof settled> | undefined;
    let second: ReturnType<typeof settled> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('medclinic:schedule-import-queue'))");
      first = settled(importFirst ? incoming() : changeCapacity(input(1), actor.userId));
      await Promise.race([waitForQueue(1), first.then((result) => { throw result.error ?? new Error("First mutation bypassed queue"); })]);
      second = settled(importFirst ? changeCapacity(input(1), actor.userId) : incoming());
      await Promise.race([waitForQueue(2), second.then((result) => { throw result.error ?? new Error("Second mutation bypassed queue"); })]);
      await blocker.query("COMMIT");
      const results = await Promise.all([first, second]);
      expect(results[0].error).toBeNull();
      if (importFirst) {
        expect(results[1].error).toMatchObject({ code: "CAPACITY_COMMITTED_WORKLOAD_CONFLICT", status: 409 });
        expect(await current()).toBe(2);
      } else {
        expect(results[1].error).toBeNull();
        expect(await current()).toBe(1);
      }
      const loads = await pool.query("SELECT COUNT(*)::int AS count FROM appointments WHERE schedule_type='LABORATORY' AND student_number LIKE '99-97%' GROUP BY appointment_date");
      expect(loads.rows.every((row) => row.count <= (importFirst ? 2 : 1))).toBe(true);
      expect((await pool.query("SELECT 1 FROM appointments WHERE student_number='99-9799-91' AND is_published")).rowCount).toBe(2);
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      await Promise.all([first, second].filter(Boolean));
    }
  });
});
