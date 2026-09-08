// @vitest-environment node
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { startLoopbackSmtpSink } from "./loopback-smtp-sink";

describe("loopback SMTP acceptance sink", () => {
  it("captures a synthetic .test message through SMTP for deliberate local inspection", async () => {
    const sink = await startLoopbackSmtpSink({ port: 0 });
    try {
      const transport = nodemailer.createTransport({
        host: sink.host,
        port: sink.port,
        secure: false,
      });
      await transport.sendMail({
        from: "clinic@example.test",
        to: "administrator@bootstrap.test",
        subject: "Verify your email",
        text: "Deliberate inspection token: local-only-token",
      });

      const message = await sink.waitForMessage({ timeoutMs: 2_000 });
      expect(message.envelope).toEqual({
        mailFrom: "clinic@example.test",
        rcptTo: ["administrator@bootstrap.test"],
      });
      expect(message.raw.toString("utf8")).toContain("local-only-token");
      expect(sink.messages).toHaveLength(1);
    } finally {
      await sink.close();
    }
  });

  it("rejects recipients outside the reserved .test domain", async () => {
    const sink = await startLoopbackSmtpSink({ port: 0 });
    try {
      const transport = nodemailer.createTransport({
        host: sink.host,
        port: sink.port,
        secure: false,
      });
      await expect(transport.sendMail({
        from: "clinic@example.test",
        to: "somebody@example.com",
        subject: "Must be refused",
        text: "Never accepted",
      })).rejects.toThrow();
      expect(sink.messages).toHaveLength(0);
    } finally {
      await sink.close();
    }
  });
});
