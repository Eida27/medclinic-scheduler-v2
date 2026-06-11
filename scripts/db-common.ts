import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";

export function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

export async function withClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

export async function sqlFiles(directory: string): Promise<Array<{ name: string; sql: string }>> {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await fs.readFile(path.join(directory, name), "utf8") })),
  );
}

export const projectPath = (...parts: string[]): string => path.join(process.cwd(), ...parts);
