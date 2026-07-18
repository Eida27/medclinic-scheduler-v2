import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { serverEnv } from "@/lib/env";
import type { ResultStorage } from "./result-storage";

export class LocalResultStorage implements ResultStorage {
  readonly root: string;

  constructor(root = serverEnv().RESULT_UPLOAD_ROOT) {
    this.root = resolve(root);
  }

  private pathFor(storageKey: string) {
    if (isAbsolute(storageKey) || storageKey.includes("..") || storageKey.includes("\\")) {
      throw new Error("Invalid result storage key.");
    }
    const target = resolve(this.root, storageKey);
    if (!target.startsWith(`${this.root}${sep}`)) throw new Error("Invalid result storage key.");
    return target;
  }

  async write(storageKey: string, bytes: Buffer) {
    const target = this.pathFor(storageKey);
    const directory = dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  read(storageKey: string) {
    return readFile(this.pathFor(storageKey));
  }

  async delete(storageKey: string) {
    await rm(this.pathFor(storageKey), { force: true });
  }
}

export const localResultStorage = new LocalResultStorage();
