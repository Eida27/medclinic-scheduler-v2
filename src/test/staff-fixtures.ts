import bcrypt from "bcryptjs";
import { pool } from "@/server/db/pool";
import { TEST_REFERENCE_IDS } from "./integration-fixtures";

export const TEST_STAFF_ACCOUNTS = [
  {
    id: TEST_REFERENCE_IDS.adminUser,
    fullName: "System Admin",
    email: "admin@medclinic.local",
    password: "Admin123!",
    role: "ADMIN",
    clinicId: null,
  },
  {
    id: TEST_REFERENCE_IDS.clinicStaffUser,
    fullName: "Clinic Staff",
    email: "staff@medclinic.local",
    password: "Staff123!",
    role: "CLINIC_STAFF",
    clinicId: TEST_REFERENCE_IDS.laboratoryClinic,
  },
  {
    id: TEST_REFERENCE_IDS.coordinatorUser,
    fullName: "Schedule Coordinator",
    email: "coordinator@medclinic.local",
    password: "Coordinator123!",
    role: "COORDINATOR",
    clinicId: null,
  },
] as const;

export async function ensureTestStaffFixtures() {
  for (const account of TEST_STAFF_ACCOUNTS) {
    const passwordHash = await bcrypt.hash(account.password, 4);
    await pool.query(
      `INSERT INTO users (
         id,full_name,email,password_hash,role,clinic_id,email_verified_at,
         must_change_password,credential_version,deleted_at,deleted_by
       ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),FALSE,1,NULL,NULL)
       ON CONFLICT (id) DO UPDATE SET
         full_name=EXCLUDED.full_name,
         email=EXCLUDED.email,
         password_hash=EXCLUDED.password_hash,
         role=EXCLUDED.role,
         clinic_id=EXCLUDED.clinic_id,
         email_verified_at=EXCLUDED.email_verified_at,
         must_change_password=FALSE,
         credential_version=1,
         deleted_at=NULL,
         deleted_by=NULL`,
      [account.id, account.fullName, account.email, passwordHash, account.role, account.clinicId],
    );
  }
}
