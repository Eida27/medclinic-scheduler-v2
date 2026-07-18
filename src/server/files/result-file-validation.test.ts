// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateResultFile } from "./result-file-validation";

const pdf = Buffer.from("%PDF-1.7\nsynthetic result");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe("result file validation", () => {
  it.each([
    ["result.pdf", "application/pdf", pdf, "pdf"],
    ["result.png", "image/png", png, "png"],
    ["result.jpg", "image/jpeg", jpeg, "jpg"],
    ["result.jpeg", "image/jpeg", jpeg, "jpeg"],
  ])("accepts matching %s content", (filename, mimeType, bytes, extension) => {
    expect(validateResultFile({ filename, declaredMimeType: mimeType, bytes })).toMatchObject({
      detectedMimeType: mimeType,
      extension,
      byteSize: bytes.byteLength,
      checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    ["result.pdf", "application/pdf", png],
    ["result.png", "image/png", pdf],
    ["result.jpg", "image/png", jpeg],
    ["result.exe", "application/pdf", pdf],
  ])("rejects mismatched extension, MIME, or signature for %s", (filename, mimeType, bytes) => {
    expect(() => validateResultFile({ filename, declaredMimeType: mimeType, bytes }))
      .toThrow(/PDF, JPG, JPEG, or PNG|do not match/i);
  });

  it("rejects empty files and files over 20 MB", () => {
    expect(() => validateResultFile({
      filename: "empty.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.alloc(0),
    })).toThrow(/empty/i);
    expect(() => validateResultFile({
      filename: "large.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(20 * 1024 * 1024)]),
    })).toThrow(/20 MB/i);
  });
});
