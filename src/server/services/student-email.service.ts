import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { transaction } from "@/server/db/pool";
import { enqueueStudentEmail } from "@/server/repositories/student-notifications.repository";

const emailSchema = z.string().trim().toLowerCase().email().max(254);

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function requestStudentEmailVerification(studentNumber: string, email: string) {
  const normalizedEmail = emailSchema.parse(email);
  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  await transaction(async (client) => {
    const student = await client.query(
      "SELECT student_number FROM students WHERE student_number=$1 AND is_active=TRUE FOR UPDATE",
      [studentNumber],
    );
    if (!student.rowCount) throw new AppError("STUDENT_NOT_FOUND", "Student not found.", 404);
    await client.query(
      `UPDATE student_email_verifications
          SET consumed_at=COALESCE(consumed_at,NOW())
        WHERE student_number=$1 AND consumed_at IS NULL`,
      [studentNumber],
    );
    await client.query(
      `INSERT INTO student_email_verifications (
         student_number, pending_email, token_hash, expires_at
       ) VALUES ($1,$2,$3,NOW() + INTERVAL '30 minutes')`,
      [studentNumber, normalizedEmail, hash],
    );
    const verifyUrl = `${serverEnv().APP_URL}/student/email-verification?token=${encodeURIComponent(token)}`;
    await enqueueStudentEmail(client, {
      studentNumber,
      toEmail: normalizedEmail,
      subject: "Verify your MedClinic notification email",
      textBody: `Verify your email within 30 minutes: ${verifyUrl}`,
    });
  });
  return { token, expiresInMinutes: 30 };
}

export async function verifyStudentEmail(studentNumber: string, token: string) {
  const hash = tokenHash(z.string().min(1).max(256).parse(token));
  return transaction(async (client) => {
    const verification = await client.query<{ id: string; pendingEmail: string }>(
      `SELECT id, pending_email AS "pendingEmail"
         FROM student_email_verifications
        WHERE student_number=$1 AND token_hash=$2
          AND consumed_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [studentNumber, hash],
    );
    if (!verification.rowCount) {
      throw new AppError("EMAIL_VERIFICATION_INVALID", "This verification link is invalid or expired.", 422);
    }
    await client.query(
      `UPDATE students
          SET email=$2, email_verified_at=NOW()
        WHERE student_number=$1 AND is_active=TRUE`,
      [studentNumber, verification.rows[0].pendingEmail],
    );
    await client.query(
      "UPDATE student_email_verifications SET consumed_at=NOW() WHERE id=$1",
      [verification.rows[0].id],
    );
    return { email: verification.rows[0].pendingEmail };
  });
}
