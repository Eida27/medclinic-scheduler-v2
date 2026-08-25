import { pool } from "@/server/db/pool";
import { ensureTestStaffFixtures } from "@/test/staff-fixtures";

export default async function globalSetup() {
  await ensureTestStaffFixtures();
  await pool.end();
}
