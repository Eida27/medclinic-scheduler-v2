// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnv } from "./env";

const validKey = Buffer.alloc(32, 7).toString("base64");

function stubRequiredEnvironment(encryptionKey: string | undefined) {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/medclinic_scheduler");
  vi.stubEnv("JWT_SECRET", "test-secret-with-at-least-thirty-two-characters");
  if (encryptionKey === undefined) vi.stubEnv("EMAIL_OUTBOX_ENCRYPTION_KEY", "");
  else vi.stubEnv("EMAIL_OUTBOX_ENCRYPTION_KEY", encryptionKey);
}

afterEach(() => vi.unstubAllEnvs());

describe("EMAIL_OUTBOX_ENCRYPTION_KEY environment validation", () => {
  it("accepts a dedicated Base64-encoded 32-byte key", () => {
    stubRequiredEnvironment(validKey);
    expect(serverEnv().EMAIL_OUTBOX_ENCRYPTION_KEY).toBe(validKey);
  });

  it("rejects a missing or incorrectly sized key", () => {
    stubRequiredEnvironment(undefined);
    expect(() => serverEnv()).toThrow();
    stubRequiredEnvironment(Buffer.alloc(16, 7).toString("base64"));
    expect(() => serverEnv()).toThrow();
  });
});
