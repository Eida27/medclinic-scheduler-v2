import "server-only";

export interface ResultStorage {
  write(storageKey: string, bytes: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}
