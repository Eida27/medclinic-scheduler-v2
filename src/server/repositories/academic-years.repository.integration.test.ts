// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "@/test/integration-fixtures";
import {
  createAcademicYearWithClient,
  deleteAcademicYearWithClient,
  listAcademicYearRecords,
  lockAcademicYearWithSnapshotCount,
  updateAcademicYearClosingDateWithClient,
} from "./academic-years.repository";

afterAll(async () => {
  await pool.end();
});

describe("academic-years repository", () => {
  it("returns linked counts and preserves the creator when the closing date changes", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await createAcademicYearWithClient(client, {
        startYear: 2097,
        closingDate: "2098-07-31",
        actorUserId: TEST_REFERENCE_IDS.adminUser,
      });
      await client.query(
        `INSERT INTO student_academic_snapshots (
           student_number,academic_year_start,student_name,college_name,
           program_name,source_type
         ) VALUES ('97-0001-01',2097,'Historical, Student','Historical College',
                   'Historical Program','VERIFIED_HISTORICAL')`,
      );

      const listed = await listAcademicYearRecords(client);
      expect(listed.find((year) => year.startYear === 2097)).toMatchObject({
        closingDate: "2098-07-31",
        createdBy: TEST_REFERENCE_IDS.adminUser,
        updatedBy: TEST_REFERENCE_IDS.adminUser,
        linkedSnapshotCount: 1,
      });
      await expect(lockAcademicYearWithSnapshotCount(client, 2097)).resolves.toMatchObject({
        linkedSnapshotCount: 1,
      });

      const updated = await updateAcademicYearClosingDateWithClient(client, {
        startYear: 2097,
        closingDate: "2098-07-15",
        actorUserId: TEST_REFERENCE_IDS.clinicStaffUser,
      });
      expect(updated).toMatchObject({
        closingDate: "2098-07-15",
        createdBy: TEST_REFERENCE_IDS.adminUser,
        updatedBy: TEST_REFERENCE_IDS.clinicStaffUser,
        linkedSnapshotCount: 1,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("deletes an unlinked year and returns the deleted metadata", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await createAcademicYearWithClient(client, {
        startYear: 2098,
        closingDate: "2099-07-31",
        actorUserId: TEST_REFERENCE_IDS.adminUser,
      });

      await expect(deleteAcademicYearWithClient(client, 2098)).resolves.toMatchObject({
        startYear: 2098,
        closingDate: "2099-07-31",
        linkedSnapshotCount: 0,
      });
      await expect(lockAcademicYearWithSnapshotCount(client, 2098)).resolves.toBeUndefined();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
