import "server-only";
import nodemailer from "nodemailer";
import { serverEnv } from "@/lib/env";
import {
  claimEmailOutboxRows,
  markEmailOutboxFailed,
  markEmailOutboxSent,
  type ClaimedEmailOutboxMessage,
} from "@/server/repositories/email-outbox.repository";

export type EmailTransport = {
  sendMail(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
};

export function claimEmailOutboxMessages(limit: number, now = new Date()) {
  return claimEmailOutboxRows(limit, now);
}

export async function deliverClaimedEmail(
  message: ClaimedEmailOutboxMessage,
  transport: EmailTransport,
  now = new Date(),
  from: string,
) {
  const attempts = message.attempts + 1;
  try {
    await transport.sendMail({
      from,
      to: message.toEmail,
      subject: message.subject,
      text: message.textBody,
      ...(message.htmlBody ? { html: message.htmlBody } : {}),
    });
    await markEmailOutboxSent(message.id, attempts, now);
    return { status: "SENT" as const };
  } catch (error) {
    const delayMinutes = attempts >= 10 ? 0 : Math.min(2 ** (attempts - 1), 60);
    const nextAttemptAt = new Date(now.getTime() + delayMinutes * 60 * 1000);
    await markEmailOutboxFailed(
      message.id,
      attempts,
      nextAttemptAt,
      error instanceof Error ? error.message : "Unknown SMTP error",
    );
    return { status: attempts >= 10 ? "PERMANENT_FAILURE" as const : "PENDING" as const };
  }
}

export async function deliverEmailOutboxBatch(now = new Date()) {
  const env = serverEnv();
  if (!env.SMTP_HOST || !env.SMTP_FROM) return { skipped: true, processedCount: 0 };
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER && env.SMTP_PASS
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
      : {}),
  });
  const messages = await claimEmailOutboxMessages(25, now);
  for (const message of messages) {
    await deliverClaimedEmail(message, transport, now, env.SMTP_FROM);
  }
  return { skipped: false, processedCount: messages.length };
}
