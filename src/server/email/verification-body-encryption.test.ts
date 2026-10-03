// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decryptEmailOutboxSensitiveBody,
  encryptEmailOutboxSensitiveBody,
  parseEmailOutboxEncryptionKey,
} from "./verification-body-encryption";

const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");
const iv = Buffer.from("000102030405060708090a0b", "hex");

describe("verification email body encryption", () => {
  it("accepts only Base64 keys that decode to exactly 32 bytes", () => {
    expect(parseEmailOutboxEncryptionKey(key)).toEqual(
      Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
    );
    expect(() => parseEmailOutboxEncryptionKey(Buffer.alloc(31, 1).toString("base64")))
      .toThrow("EMAIL_OUTBOX_ENCRYPTION_KEY must be Base64 encoding exactly 32 bytes.");
    expect(() => parseEmailOutboxEncryptionKey("not-base64"))
      .toThrow("EMAIL_OUTBOX_ENCRYPTION_KEY must be Base64 encoding exactly 32 bytes.");
  });

  it("uses a deterministic versioned AES-256-GCM envelope when an IV seam is supplied", () => {
    const encrypted = encryptEmailOutboxSensitiveBody("verification token body", key, { iv });
    expect(encrypted).toBe("v1.AAECAwQFBgcICQoL.W4DJFb9xsc3ctR7QUbu-b4NmI-VT2A0.oVhxaT_YbG-PByeFK6ShmQ");
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(encrypted.split(".")).toHaveLength(4);
    expect(encryptEmailOutboxSensitiveBody("verification token body", key, { iv })).toBe(encrypted);
    expect(decryptEmailOutboxSensitiveBody(encrypted, key)).toBe("verification token body");
  });

  it("rejects a tampered authentication tag", () => {
    const encrypted = encryptEmailOutboxSensitiveBody("verification token body", key, { iv });
    const parts = encrypted.split(".");
    const tag = Buffer.from(parts[3], "base64url");
    tag[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], tag.toString("base64url")].join(".");
    expect(() => decryptEmailOutboxSensitiveBody(tampered, key)).toThrow("Verification email body could not be decrypted.");
  });
});
