// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizePhysicianSignature } from "./physician.service";

describe("physician signature normalization", () => {
  it("accepts a decoded PNG and removes source metadata", async () => {
    const input = await sharp({ create: { width: 320, height: 120, channels: 4, background: "#ffffff" } })
      .withMetadata({ density: 144 }).png().toBuffer();
    const output = await normalizePhysicianSignature(input, "image/png");
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.density).not.toBe(144);
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects non-image content, type mismatch, and oversized input", async () => {
    await expect(normalizePhysicianSignature(Buffer.from("<svg></svg>"), "image/svg+xml"))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).jpeg().toBuffer();
    await expect(normalizePhysicianSignature(jpeg, "image/png"))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    await expect(normalizePhysicianSignature(Buffer.alloc(1024 * 1024 + 1), "image/png"))
      .rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });
});
