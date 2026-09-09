// @vitest-environment node
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstallationPreflight } from "./installation-preflight";
import { startLoopbackSmtpSink } from "./loopback-smtp-sink";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("live installation preflight", () => {
  it("connects to the owned database, writable private storage, and loopback SMTP", async () => {
    const sink = await startLoopbackSmtpSink({ port: 0 });
    const storageRoot = await mkdtemp(path.join(tmpdir(), "medclinic-live-preflight-"));
    temporaryDirectories.push(storageRoot);
    try {
      await expect(runInstallationPreflight({
        DATABASE_URL: process.env.DATABASE_URL,
        JWT_SECRET: process.env.JWT_SECRET,
        EMAIL_OUTBOX_ENCRYPTION_KEY: process.env.EMAIL_OUTBOX_ENCRYPTION_KEY,
        APP_URL: "http://127.0.0.1:3000",
        APP_TIMEZONE: "Asia/Manila",
        RESULT_UPLOAD_ROOT: storageRoot,
        SMTP_HOST: sink.host,
        SMTP_PORT: String(sink.port),
        SMTP_FROM: "clinic@installation.test",
      }, { log: () => undefined })).resolves.toEqual({
        database: "reachable",
        storage: "writable",
        smtp: "reachable",
      });
      expect((await stat(storageRoot)).isDirectory()).toBe(true);
      expect(sink.messages).toHaveLength(0);
    } finally {
      await sink.close();
    }
  });
});
