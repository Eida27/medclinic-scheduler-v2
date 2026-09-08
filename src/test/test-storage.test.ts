// @vitest-environment node
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTestStorageCleanup } from "../../scripts/test-storage";

let storageRoot: string;
beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), "medclinic-test-storage-"));
  await writeFile(path.join(storageRoot, "owned-result.txt"), "owned test residue");
});
afterEach(async () => { await rm(storageRoot, { recursive: true, force: true }); });

describe("owned test storage teardown", () => {
  it("returns successful callback output and removes owned residue", async () => {
    await expect(withTestStorageCleanup(storageRoot, async () => "completed")).resolves.toBe("completed");
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the child failure when storage cleanup succeeds", async () => {
    const childFailure = new Error("test child exited 17");
    await expect(withTestStorageCleanup(storageRoot, async () => { throw childFailure; })).rejects.toBe(childFailure);
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { childFails: false, inspectionFails: true, removalFails: false },
    { childFails: true, inspectionFails: true, removalFails: false },
    { childFails: false, inspectionFails: false, removalFails: true },
    { childFails: true, inspectionFails: false, removalFails: true },
    { childFails: false, inspectionFails: true, removalFails: true },
    { childFails: true, inspectionFails: true, removalFails: true },
  ])("retains every failure and attempts removal independently: %j", async ({ childFails, inspectionFails, removalFails }) => {
    const childFailure = new Error("test child exited 17");
    const inspectionFailure = new Error("cannot inspect owned directory");
    const removalFailure = new Error("owned file locked on Windows");
    let failure: unknown;
    try {
      await withTestStorageCleanup(storageRoot, async () => {
        if (childFails) throw childFailure;
        return "completed";
      }, {
        inspect: async (root) => {
          if (inspectionFails) throw inspectionFailure;
          return readdir(root, { recursive: true });
        },
        remove: async (root) => {
          if (removalFails) throw removalFailure;
          await rm(root, { recursive: true, force: true });
        },
      });
    } catch (error) { failure = error; }
    // Real filesystem state proves removal still ran after a failed inspection.
    if (removalFails) await expect(access(storageRoot)).resolves.toBeUndefined();
    else await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(storageRoot);
    const expected = [];
    if (childFails) expected.push(childFailure);
    if (inspectionFails) expected.push(inspectionFailure);
    if (removalFails) expected.push(removalFailure);
    expect((failure as AggregateError).errors).toEqual(expected);
  });
});
