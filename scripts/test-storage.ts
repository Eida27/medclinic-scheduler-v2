import { readdir, rm } from "node:fs/promises";

interface StorageCleanupOperations {
  inspect(root: string): Promise<string[]>;
  remove(root: string): Promise<void>;
}
const defaultOperations: StorageCleanupOperations = {
  inspect: (root) => readdir(root, { recursive: true }),
  remove: (root) => rm(root, { recursive: true, force: true }),
};

// The caller creates and owns this directory before entering the lifecycle.
export async function withTestStorageCleanup<T>(
  storageRoot: string,
  callback: () => Promise<T>,
  operations = defaultOperations,
): Promise<T> {
  const errors: unknown[] = [];
  const failedCleanupSteps: string[] = [];
  let result: T | undefined;
  try {
    result = await callback();
  } catch (error) {
    errors.push(error);
  }
  try {
    const residue = await operations.inspect(storageRoot);
    console.log(`Disposable test storage residue before removal: ${residue.length} entries.`);
  } catch (error) {
    errors.push(error);
    failedCleanupSteps.push("inspection");
  }
  // Inspection failure must never prevent an independent removal attempt.
  try {
    await operations.remove(storageRoot);
  } catch (error) {
    errors.push(error);
    failedCleanupSteps.push("removal");
  }
  if (failedCleanupSteps.length) {
    throw new AggregateError(errors,
      `Disposable test storage cleanup failed (${failedCleanupSteps.join(", ")}) for ${storageRoot}.`);
  }
  if (errors.length) throw errors[0];
  return result as T;
}
