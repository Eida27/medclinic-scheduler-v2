import { describe, expect, it, vi } from "vitest";
import {
  assertMatchingCleanupIdentity,
  assertSafeCleanupRequest,
  privateResultDirectories,
  runPersistedCatalogCleanup,
  type CatalogCleanupManifest,
  type CatalogCleanupProgress,
} from "../../scripts/db-reference-catalog-cleanup";

const identity = {
  scheme: "postgresql" as const,
  host: "localhost",
  port: "5432",
  database: "medclinic_catalog_test",
  storageRoot: "C:\\private-results",
};

const manifest: CatalogCleanupManifest = {
  obsoleteCollegeIds: ["college-old"],
  obsoleteProgramIds: ["program-old"],
  studentNumbers: ["99-0001-01"],
  importGroupIds: ["import-1"],
  batchIds: ["batch-1"],
  appointmentIds: ["appointment-1"],
  coordinatorItemIds: ["item-1"],
  submissionIds: ["submission-1"],
  resultFiles: [{ id: "file-1", storageKey: "submission-1/result.pdf" }],
  counts: { students: 1, importGroups: 1, batches: 1, appointments: 1, resultFiles: 1 },
};

describe("reference catalog cleanup guard", () => {
  it("requires an exclusive database assertion and exact destructive confirmation", () => {
    expect(() => assertSafeCleanupRequest({
      databaseUrl: "postgresql://user:pass@localhost:5432/medclinic_catalog_test",
      storageRoot: "C:\\private-results",
      exclusiveDatabase: undefined,
      confirmation: undefined,
    })).toThrow(/EXCLUSIVE_DATABASE=1/u);

    expect(() => assertSafeCleanupRequest({
      databaseUrl: "postgresql://user:pass@localhost:5432/medclinic_catalog_test",
      storageRoot: "C:\\private-results",
      exclusiveDatabase: "1",
      confirmation: "wrong",
    })).toThrow(/DELETE_NON_WORKBOOK_REFERENCE_DATA/u);

    expect(assertSafeCleanupRequest({
      databaseUrl: "postgresql://user:pass@localhost:5432/medclinic_catalog_test",
      storageRoot: "C:\\private-results",
      exclusiveDatabase: "1",
      confirmation: "DELETE_NON_WORKBOOK_REFERENCE_DATA",
    })).toEqual(identity);
  });

  it("rejects URL destination overrides and persisted identity changes", () => {
    expect(() => assertSafeCleanupRequest({
      databaseUrl: "postgresql://user:pass@localhost/medclinic_catalog_test?host=elsewhere",
      storageRoot: "C:\\private-results",
      exclusiveDatabase: "1",
      confirmation: "DELETE_NON_WORKBOOK_REFERENCE_DATA",
    })).toThrow(/host or port query parameters/u);

    expect(() => assertMatchingCleanupIdentity(
      { ...identity, database: "other_database" },
      identity,
    )).toThrow(/does not match the cleanup state/u);
  });

  it("derives unique safe private-result directories and rejects traversal", () => {
    expect(privateResultDirectories([
      "submission-1/result.pdf",
      "submission-1/second.pdf",
      "submission-2/image.png",
    ])).toEqual(["submission-1", "submission-2"]);
    expect(() => privateResultDirectories(["../outside.pdf"])).toThrow(/storage key/u);
    expect(() => privateResultDirectories(["submission-1\\outside.pdf"])).toThrow(/storage key/u);
  });
});

describe("reference catalog cleanup progress", () => {
  it("resumes private file deletion without replaying committed database deletion", async () => {
    let persisted: CatalogCleanupProgress | undefined;
    let failFileDeletion = true;
    const actions = {
      captureManifest: vi.fn(async () => manifest),
      persist: vi.fn(async (progress: CatalogCleanupProgress) => {
        persisted = structuredClone(progress);
      }),
      deleteDatabase: vi.fn(async () => undefined),
      deletePrivateFiles: vi.fn(async () => {
        if (failFileDeletion) throw new Error("injected file deletion failure");
      }),
      prove: vi.fn(async () => ({ databaseRows: 0, privateStorageDirectories: 0 })),
    };

    await expect(runPersistedCatalogCleanup(undefined, identity, actions))
      .rejects.toThrow("injected file deletion failure");
    expect(persisted).toMatchObject({
      phase: "DATABASE_DELETED",
      identity,
      privateResultDirectories: ["submission-1"],
    });

    failFileDeletion = false;
    await expect(runPersistedCatalogCleanup(persisted, identity, {
      ...actions,
      captureManifest: vi.fn(async () => { throw new Error("must not recapture"); }),
    })).resolves.toEqual({ databaseRows: 0, privateStorageDirectories: 0 });
    expect(actions.captureManifest).toHaveBeenCalledTimes(1);
    expect(actions.deleteDatabase).toHaveBeenCalledTimes(1);
    expect(actions.deletePrivateFiles).toHaveBeenCalledTimes(2);
  });
});
