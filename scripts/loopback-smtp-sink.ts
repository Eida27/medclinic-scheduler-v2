import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from "smtp-server";

export type CapturedSmtpMessage = {
  id: string;
  receivedAt: Date;
  envelope: {
    mailFrom: string | null;
    rcptTo: string[];
  };
  raw: Buffer;
};

type MessageWaiter = {
  afterCount: number;
  resolve: (message: CapturedSmtpMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type LoopbackSmtpSink = {
  host: "127.0.0.1";
  port: number;
  messages: readonly CapturedSmtpMessage[];
  waitForMessage(options?: {
    afterCount?: number;
    timeoutMs?: number;
  }): Promise<CapturedSmtpMessage>;
  close(): Promise<void>;
};

function isReservedTestRecipient(address: string) {
  return /@(?:[a-z0-9-]+\.)*test$/i.test(address);
}

function envelopeAddress(address: SMTPServerAddress | false | undefined) {
  return address ? address.address : null;
}

export async function startLoopbackSmtpSink(
  options: { port?: number } = {},
): Promise<LoopbackSmtpSink> {
  const host = "127.0.0.1" as const;
  const messages: CapturedSmtpMessage[] = [];
  const waiters = new Set<MessageWaiter>();
  let closed = false;

  function releaseWaiters() {
    for (const waiter of waiters) {
      const message = messages[waiter.afterCount];
      if (!message) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    hidePIPELINING: true,
    logger: false,
    onRcptTo(address, _session, callback) {
      if (!isReservedTestRecipient(address.address)) {
        const error = new Error("The loopback SMTP sink accepts only reserved .test recipients.") as Error & { responseCode?: number };
        error.responseCode = 553;
        callback(error);
        return;
      }
      callback();
    },
    onData(stream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let failed = false;
      stream.on("data", (chunk: Buffer | string) => {
        if (failed) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.length;
        if (byteLength > 5 * 1024 * 1024) {
          failed = true;
          const error = new Error("Message exceeds the loopback SMTP sink limit.") as Error & { responseCode?: number };
          error.responseCode = 552;
          callback(error);
          stream.resume();
          return;
        }
        chunks.push(bytes);
      });
      stream.on("end", () => {
        if (failed) return;
        messages.push({
          id: randomUUID(),
          receivedAt: new Date(),
          envelope: {
            mailFrom: envelopeAddress(session.envelope.mailFrom),
            rcptTo: session.envelope.rcptTo.map((address) => address.address),
          },
          raw: Buffer.concat(chunks),
        });
        releaseWaiters();
        callback();
      });
      stream.on("error", (error) => {
        if (!failed) callback(error);
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.listen(options.port ?? 2525, host, onListening);
  });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Loopback SMTP sink did not expose a TCP listener.");
  }

  return {
    host,
    port: address.port,
    get messages() {
      return messages.slice();
    },
    waitForMessage({ afterCount = 0, timeoutMs = 5_000 } = {}) {
      const captured = messages[afterCount];
      if (captured) return Promise.resolve(captured);
      if (closed) return Promise.reject(new Error("Loopback SMTP sink is closed."));
      return new Promise<CapturedSmtpMessage>((resolve, reject) => {
        const waiter: MessageWaiter = {
          afterCount,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for SMTP message ${afterCount + 1}.`));
          }, timeoutMs),
        };
        waiter.timer.unref?.();
        waiters.add(waiter);
      });
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Loopback SMTP sink closed before a message arrived."));
      }
      waiters.clear();
      return new Promise<void>((resolve) => server.close(resolve));
    },
  };
}

function isDirectExecution() {
  return Boolean(process.argv[1])
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  const sink = await startLoopbackSmtpSink({
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 2525,
  });
  console.log(`Loopback SMTP sink listening on ${sink.host}:${sink.port}; reserved .test recipients only.`);
  const close = async () => {
    console.log(`Loopback SMTP sink closing; captured messages: ${sink.messages.length}.`);
    await sink.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
