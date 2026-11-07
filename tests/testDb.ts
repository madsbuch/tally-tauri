import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

// One in-memory database for every test file: bun runs them in one process,
// so db.ts (and its cached connection) is shared — two files mocking
// tauri-plugin-sql with two databases would write to one and read the other.
// Migrations are applied in the order lib.rs registers them.
export const sqlite = new Database(":memory:");
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
for (const match of rust.matchAll(/include_str!\("\.\.\/migrations\/([^\"]+)"\)/g)) {
  sqlite.exec(readFileSync(new URL(`../src-tauri/migrations/${match[1]}`, import.meta.url), "utf8"));
}
mock.module("@tauri-apps/plugin-sql", () => ({ default: {
  load: async () => ({
    execute: async (sql: string, params: never[] = []) => sqlite.query(sql).run(...params),
    select: async (sql: string, params: never[] = []) => sqlite.query(sql).all(...params),
  }),
} }));
