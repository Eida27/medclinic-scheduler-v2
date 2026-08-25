import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ENVELOPE_VERSION = "v1";
const ENVELOPE_AAD = Buffer.from("medclinic:email-outbox:verification:v1", "utf8");
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const INVALID_KEY_MESSAGE =
  "EMAIL_OUTBOX_ENCRYPTION_KEY must be Base64 encoding exactly 32 bytes.";
const DECRYPTION_ERROR_MESSAGE = "Verification email body could not be decrypted.";

export function parseEmailOutboxEncryptionKey(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(INVALID_KEY_MESSAGE);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== value) {
    throw new Error(INVALID_KEY_MESSAGE);
  }
  return key;
}

export function encryptEmailOutboxSensitiveBody(
  plaintext: string,
  encodedKey: string,
  dependencies: { iv?: Uint8Array } = {},
) {
  const key = parseEmailOutboxEncryptionKey(encodedKey);
  const iv = dependencies.iv ? Buffer.from(dependencies.iv) : randomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new Error("Verification email encryption IV must be 12 bytes.");

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ENVELOPE_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authenticationTag.toString("base64url"),
  ].join(".");
}

export function decryptEmailOutboxSensitiveBody(envelope: string, encodedKey: string) {
  try {
    const key = parseEmailOutboxEncryptionKey(encodedKey);
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new Error(DECRYPTION_ERROR_MESSAGE);
    }
    const iv = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    const authenticationTag = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || authenticationTag.length !== AUTH_TAG_BYTES) {
      throw new Error(DECRYPTION_ERROR_MESSAGE);
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(authenticationTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(DECRYPTION_ERROR_MESSAGE);
  }
}

// Compatibility aliases: student verification messages retain the same v1 envelope and AAD.
export const encryptVerificationEmailBody = encryptEmailOutboxSensitiveBody;
export const decryptVerificationEmailBody = decryptEmailOutboxSensitiveBody;
