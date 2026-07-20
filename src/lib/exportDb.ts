import { invoke } from "@tauri-apps/api/core";
import { getDb, todayStr } from "./db";

// ---------------------------------------------------------------------------
// Raw database export. `VACUUM INTO` writes a compact, transactionally
// consistent snapshot of the live DB (including un-checkpointed WAL data) to a
// fresh file, which Android then hands to the system share sheet.
// ---------------------------------------------------------------------------

export interface ExportResult {
  /** Absolute path of the snapshot file. */
  path: string;
  /** True when the Android share sheet was opened for it. */
  shared: boolean;
}

function isAndroid(): boolean {
  return navigator.userAgent.includes("Android");
}

export async function exportDatabase(): Promise<ExportResult> {
  const fileName = `tally-${todayStr()}.db`;
  const path = await invoke<string>("prepare_db_export", { fileName });

  const conn = await getDb();
  // Path comes from our own Rust command; escape quotes for the SQL literal
  // anyway (VACUUM INTO's filename can't always be bound as a parameter).
  await conn.execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  if (isAndroid()) {
    await invoke("plugin:share|share_file", {
      path,
      mime: "application/octet-stream",
      title: "Export Tally database",
    });
    return { path, shared: true };
  }
  return { path, shared: false };
}
