// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalResultStorage } from "./local-result-storage";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medclinic-result-storage-"));
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("local result storage", () => {
  it("promotes a temporary file atomically under a generated private key", async () => {
    const storage = new LocalResultStorage(root);
    const key = "00000000-0000-4000-8000-000000000010/00000000-0000-4000-8000-000000000011.pdf";
    const bytes = Buffer.from("%PDF-1.7\nprivate");
    await storage.write(key, bytes);
    await expect(storage.read(key)).resolves.toEqual(bytes);
    expect(await readdir(join(root, "00000000-0000-4000-8000-000000000010")))
      .toEqual(["00000000-0000-4000-8000-000000000011.pdf"]);
    await expect(readFile(join(root, key))).resolves.toEqual(bytes);
  });

  it("rejects traversal and supports deletion", async () => {
    const storage = new LocalResultStorage(root);
    await expect(storage.write("../outside.pdf", Buffer.from("%PDF-"))).rejects.toThrow(/storage key/i);
    const key = "00000000-0000-4000-8000-000000000010/file.png";
    await storage.write(key, Buffer.from([0x89, 0x50]));
    await storage.delete(key);
    await expect(storage.read(key)).rejects.toThrow();
  });
});
