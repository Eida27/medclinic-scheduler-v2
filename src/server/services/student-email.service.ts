import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { encryptVerificationEmailBody } from "@/server/email/verification-body-encryption";
import { transaction } from "@/server/db/pool";
import { enqueueStudentEmail } from "@/server/repositories/student-notifications.repository";
import { queueFirstVerificationCurrentStateCatchUp } from "./student-verification-catch-up.service";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const tokenSchema = z.string().min(1).max(256);
const VERIFICATION_LIFETIME_MINUTES = 30;
const RESEND_COOLDOWN_SECONDS = 60;
const THROTTLE_WINDOW_MINUTES = 15;
const THROTTLE_LIMIT = 5;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function addressMetadata(email: string) {
  const [local, domain = ""] = email.split("@");
  return {
    addressHash: createHash("sha256").update(email).digest("hex"),
    addressMasked: `${local.slice(0, 1)}***@${domain}`,
  };
}

async function writeVerificationAudit(
  client: PoolClient,
  studentNumber: string,
  action: string,
  email: string,
  extra: Record<string, unknown> = {},
) {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
     VALUES (NULL,$1,'student_email_verification',$2,$3::jsonb)`,
    [action, studentNumber, JSON.stringify({ ...addressMetadata(email), ...extra })],
  );
}

function retryDetails(retryAt: Date, databaseNow: Date) {
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - databaseNow.getTime()) / 1000)),
    retryAt: retryAt.toISOString(),
  };
}

type RequestOutcome =
  | { type: "success"; token: string; expiresAt: Date; resendAvailableAt: Date }
  | { type: "error"; error: AppError };

export async function requestStudentEmailVerification(studentNumber: string, email: string) {
  const normalizedEmail = emailSchema.parse(email);
  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  const outcome = await transaction<RequestOutcome>(async (client) => {
    const studentResult = await client.query<{
      email: string | null;
      emailVerifiedAt: Date | null;
      databaseNow: Date;
    }>(
      `SELECT email,email_verified_at AS "emailVerifiedAt",NOW() AS "databaseNow"
         FROM students WHERE student_number=$1 AND is_active=TRUE FOR UPDATE`,
      [studentNumber],
    );
    const student = studentResult.rows[0];
    if (!student) {
      return { type: "error", error: new AppError("STUDENT_NOT_FOUND", "Student not found.", 404) };
    }

    const recent = await client.query<{ createdAt: Date }>(
      `SELECT created_at AS "createdAt" FROM student_email_verifications
        WHERE student_number=$1 AND created_at > NOW()-INTERVAL '15 minutes'
        ORDER BY created_at`,
      [studentNumber],
    );
    if (recent.rows.length >= THROTTLE_LIMIT) {
      const retryAt = new Date(recent.rows[0].createdAt.getTime() + THROTTLE_WINDOW_MINUTES * 60_000);
      return {
        type: "error",
        error: new AppError(
          "EMAIL_VERIFICATION_THROTTLED",
          "Too many verification emails were requested. Try again shortly.",
          429,
          undefined,
          retryDetails(retryAt, student.databaseNow),
        ),
      };
    }
    const latest = recent.rows.at(-1);
    if (latest) {
      const resendAvailableAt = new Date(latest.createdAt.getTime() + RESEND_COOLDOWN_SECONDS * 1_000);
      if (resendAvailableAt.getTime() > student.databaseNow.getTime()) {
        return {
          type: "error",
          error: new AppError(
            "EMAIL_VERIFICATION_COOLDOWN",
            "Please wait before requesting another verification email.",
            429,
            undefined,
            retryDetails(resendAvailableAt, student.databaseNow),
          ),
        };
      }
    }

    const owner = await client.query(
      `SELECT student_number FROM students
        WHERE is_active=TRUE AND email_verified_at IS NOT NULL
          AND LOWER(BTRIM(email))=$1 AND student_number<>$2 LIMIT 1`,
      [normalizedEmail, studentNumber],
    );
    if (owner.rowCount) {
      await client.query(
        `INSERT INTO student_email_verifications (
           student_number,pending_email,token_hash,expires_at,consumed_at
         ) VALUES ($1,$2,$3,NOW()+INTERVAL '30 minutes',NOW())`,
        [studentNumber, normalizedEmail, hash],
      );
      await writeVerificationAudit(client, studentNumber, "STUDENT_EMAIL_OWNERSHIP_CONFLICT", normalizedEmail, {
        stage: "request",
      });
      return {
        type: "error",
        error: new AppError(
          "EMAIL_ALREADY_IN_USE",
          "That email address is already verified for another active student. Use another address.",
          409,
        ),
      };
    }

    const previous = await client.query<{ id: string; pendingEmail: string }>(
      `UPDATE student_email_verifications SET consumed_at=COALESCE(consumed_at,NOW())
        WHERE student_number=$1 AND consumed_at IS NULL
        RETURNING id::text,pending_email AS "pendingEmail"`,
      [studentNumber],
    );
    const previousIds = previous.rows.map((row) => row.id);
    if (previousIds.length) {
      await client.query(
        `WITH obsolete AS (
           UPDATE email_outbox
              SET status='OBSOLETE',verification_body_encrypted=NULL,locked_at=NULL,
                  last_attempt_at=NOW(),last_attempt_status='OBSOLETE'
            WHERE message_kind='VERIFICATION' AND source_type='STUDENT_EMAIL_VERIFICATION'
              AND source_id=ANY($1::text[]) AND status NOT IN ('SENT','OBSOLETE')
            RETURNING id,student_number,to_email,message_kind,notification_type,source_type,source_id
         )
         INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
         SELECT NULL,'EMAIL_OUTBOX_OBSOLETE','email_outbox',id::text,
                jsonb_build_object(
                  'studentNumber',student_number,'messageKind',message_kind,
                  'notificationType',notification_type,'sourceType',source_type,'sourceId',source_id,
                  'destinationHash',encode(digest(LOWER(BTRIM(to_email)),'sha256'),'hex'),
                  'reason','SUPERSEDED'
                ) FROM obsolete`,
        [previousIds],
      );
    }

    const verification = await client.query<{ id: string; expiresAt: Date; resendAvailableAt: Date }>(
      `INSERT INTO student_email_verifications (student_number,pending_email,token_hash,expires_at)
       VALUES ($1,$2,$3,NOW()+INTERVAL '30 minutes')
       RETURNING id::text,expires_at AS "expiresAt",
                 created_at+INTERVAL '60 seconds' AS "resendAvailableAt"`,
      [studentNumber, normalizedEmail, hash],
    );
    const row = verification.rows[0];
    const env = serverEnv();
    const verifyUrl = `${env.APP_URL}/student/email-verification/confirm?token=${encodeURIComponent(token)}`;
    await enqueueStudentEmail(client, {
      studentNumber,
      toEmail: normalizedEmail,
      subject: "Verify your MedClinic notification email",
      textBody: "Verification email content is encrypted.",
      messageKind: "VERIFICATION",
      notificationType: "EMAIL_VERIFICATION",
      sourceType: "STUDENT_EMAIL_VERIFICATION",
      sourceId: row.id,
      verificationBodyEncrypted: encryptVerificationEmailBody(
        `Verify your email within ${VERIFICATION_LIFETIME_MINUTES} minutes: ${verifyUrl}`,
        env.EMAIL_OUTBOX_ENCRYPTION_KEY,
      ),
    });
    const previousPending = previous.rows[0]?.pendingEmail;
    const action = previousPending === normalizedEmail
      ? "STUDENT_EMAIL_VERIFICATION_RESENT"
      : student.emailVerifiedAt
        ? "STUDENT_EMAIL_REPLACEMENT_REQUESTED"
        : previousPending
          ? "STUDENT_EMAIL_VERIFICATION_REPLACEMENT_REQUESTED"
          : "STUDENT_EMAIL_VERIFICATION_REQUESTED";
    await writeVerificationAudit(client, studentNumber, action, normalizedEmail, {
      expiresAt: row.expiresAt.toISOString(),
      resendAvailableAt: row.resendAvailableAt.toISOString(),
    });
    return { type: "success", token, expiresAt: row.expiresAt, resendAvailableAt: row.resendAvailableAt };
  });
  if (outcome.type === "error") throw outcome.error;
  return outcome;
}

export async function getStudentEmailVerificationStatus(studentNumber: string) {
  return transaction(async (client) => {
    const result = await client.query<{
      email: string | null;
      emailVerifiedAt: Date | null;
      pendingEmail: string | null;
      expiresAt: Date | null;
      resendAvailableAt: Date | null;
      databaseNow: Date;
    }>(
      `SELECT student.email,student.email_verified_at AS "emailVerifiedAt",
              pending.pending_email AS "pendingEmail",pending.expires_at AS "expiresAt",
              pending.created_at+INTERVAL '60 seconds' AS "resendAvailableAt",
              NOW() AS "databaseNow"
         FROM students student
         LEFT JOIN LATERAL (
           SELECT pending_email,expires_at,created_at FROM student_email_verifications
            WHERE student_number=student.student_number AND consumed_at IS NULL AND expires_at>NOW()
            ORDER BY created_at DESC LIMIT 1
         ) pending ON TRUE
        WHERE student.student_number=$1 AND student.is_active=TRUE`,
      [studentNumber],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("STUDENT_NOT_FOUND", "Student not found.", 404);
    return {
      verified: Boolean(row.email && row.emailVerifiedAt),
      verifiedEmail: row.emailVerifiedAt ? row.email : null,
      pendingEmailMasked: row.pendingEmail ? addressMetadata(row.pendingEmail).addressMasked : null,
      expiresAt: row.expiresAt,
      resendAvailableAt: row.resendAvailableAt,
      retryAfterSeconds: row.resendAvailableAt
        && row.resendAvailableAt.getTime() > row.databaseNow.getTime()
        ? retryDetails(row.resendAvailableAt, row.databaseNow).retryAfterSeconds
        : 0,
    };
  });
}

type VerifyDependencies = {
  queueCurrentStateCatchUp?: typeof queueFirstVerificationCurrentStateCatchUp;
};
type VerifyOutcome =
  | { type: "success"; email: string; firstVerification: boolean }
  | { type: "invalid" }
  | { type: "conflict" };

export async function verifyStudentEmail(token: string, dependencies: VerifyDependencies = {}) {
  const hash = tokenHash(tokenSchema.parse(token));
  const catchUp = dependencies.queueCurrentStateCatchUp ?? queueFirstVerificationCurrentStateCatchUp;
  const outcome = await transaction<VerifyOutcome>(async (client) => {
    const candidate = await client.query<{ studentNumber: string }>(
      `SELECT student_number AS "studentNumber"
         FROM student_email_verifications WHERE token_hash=$1`,
      [hash],
    );
    if (!candidate.rows[0]) return { type: "invalid" };

    const studentResult = await client.query<{ email: string | null; emailVerifiedAt: Date | null }>(
      `SELECT email,email_verified_at AS "emailVerifiedAt" FROM students
        WHERE student_number=$1 AND is_active=TRUE FOR UPDATE`,
      [candidate.rows[0].studentNumber],
    );
    const student = studentResult.rows[0];
    if (!student) return { type: "invalid" };

    const verification = await client.query<{
      id: string;
      studentNumber: string;
      pendingEmail: string;
      consumedAt: Date | null;
      isValid: boolean;
    }>(
      `SELECT id::text,student_number AS "studentNumber",pending_email AS "pendingEmail",
              consumed_at AS "consumedAt",expires_at>NOW() AS "isValid"
         FROM student_email_verifications WHERE token_hash=$1 FOR UPDATE`,
      [hash],
    );
    const request = verification.rows[0];
    if (!request || request.consumedAt || !request.isValid) return { type: "invalid" };
    const normalizedEmail = emailSchema.parse(request.pendingEmail);
    const owner = await client.query(
      `SELECT student_number FROM students
        WHERE is_active=TRUE AND email_verified_at IS NOT NULL
          AND LOWER(BTRIM(email))=$1 AND student_number<>$2 LIMIT 1`,
      [normalizedEmail, request.studentNumber],
    );
    if (owner.rowCount) {
      await client.query("UPDATE student_email_verifications SET consumed_at=NOW() WHERE id=$1", [request.id]);
      await writeVerificationAudit(client, request.studentNumber, "STUDENT_EMAIL_OWNERSHIP_CONFLICT", normalizedEmail, {
        stage: "completion",
      });
      return { type: "conflict" };
    }

    await client.query("SAVEPOINT verify_email_ownership");
    try {
      await client.query(
        "UPDATE students SET email=$2,email_verified_at=NOW() WHERE student_number=$1 AND is_active=TRUE",
        [request.studentNumber, normalizedEmail],
      );
      await client.query("RELEASE SAVEPOINT verify_email_ownership");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT verify_email_ownership");
      if (!isPostgresUniqueViolation(error)) throw error;
      await client.query("UPDATE student_email_verifications SET consumed_at=NOW() WHERE id=$1", [request.id]);
      await writeVerificationAudit(client, request.studentNumber, "STUDENT_EMAIL_OWNERSHIP_CONFLICT", normalizedEmail, {
        stage: "completion-race",
      });
      return { type: "conflict" };
    }

    await client.query("UPDATE student_email_verifications SET consumed_at=NOW() WHERE id=$1", [request.id]);
    const firstVerification = !student.emailVerifiedAt;
    await writeVerificationAudit(client, request.studentNumber, "STUDENT_EMAIL_VERIFICATION_COMPLETED", normalizedEmail, {
      firstVerification,
    });
    if (!firstVerification && student.email && emailSchema.parse(student.email) !== normalizedEmail) {
      const previous = addressMetadata(emailSchema.parse(student.email));
      await writeVerificationAudit(client, request.studentNumber, "STUDENT_EMAIL_ADDRESS_REPLACED", normalizedEmail, {
        previousAddressHash: previous.addressHash,
        previousAddressMasked: previous.addressMasked,
      });
    }
    if (firstVerification) await catchUp(client, request.studentNumber);
    return { type: "success", email: normalizedEmail, firstVerification };
  });
  if (outcome.type === "invalid") {
    throw new AppError("EMAIL_VERIFICATION_INVALID", "This verification link is invalid or expired.", 422);
  }
  if (outcome.type === "conflict") {
    throw new AppError(
      "EMAIL_ALREADY_IN_USE",
      "That email address was verified by another active student. Return to the portal and use another address.",
      409,
    );
  }
  return { email: outcome.email, firstVerification: outcome.firstVerification };
}
