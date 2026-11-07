import { invoke } from "@tauri-apps/api/core";
import { getDb } from "./db";

/**
 * Decode an image file to an ImageBitmap.
 *
 * The WebView's native decoder (`createImageBitmap`) handles JPEG/PNG/WebP but,
 * on Android/Chromium and the desktop WebViews, cannot decode HEIC/HEIF — the
 * default iPhone photo format. When native decoding fails we fall back to a
 * libheif WASM decoder (loaded lazily so non-HEIC picks pay nothing for it). If
 * that also fails, the original decode error is surfaced.
 */
async function decodeToBitmap(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch (nativeErr) {
    let decoded;
    try {
      const { default: decode } = await import("heic-decode");
      decoded = await decode({ buffer: new Uint8Array(await file.arrayBuffer()) });
    } catch {
      // Not a HEIC image (or genuinely corrupt): surface the native error.
      throw nativeErr;
    }
    const { width, height, data } = decoded;
    return await createImageBitmap(new ImageData(data, width, height));
  }
}

/**
 * Downscale and re-encode an image file to JPEG.
 * Returns a data URL (for the vision model / preview) and the raw base64
 * payload (for saving to disk via the Rust command).
 */
export async function compressImage(
  file: Blob,
  maxDim = 1280,
  quality = 0.85,
): Promise<{ dataUrl: string; base64: string }> {
  const bitmap = await decodeToBitmap(file);
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return { dataUrl, base64 };
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Stored photos live in the `photos` table of the app database, keyed by
// filename (what `photo_path` columns hold). The bytes go through the Rust
// commands rather than drizzle so they're bound as a BLOB, not JSON. Each
// call waits for the DB to be loaded: the commands borrow the SQL plugin's
// connection, which only exists once `getDb()` has run.
// ---------------------------------------------------------------------------

/** Persist a base64 JPEG; returns the filename it's stored under. */
export async function savePhoto(base64: string): Promise<string> {
  await getDb();
  return invoke<string>("save_photo", { dataBase64: base64 });
}

/**
 * Recently read photos, as data URLs. Thumbnails in a scrolling diary are
 * re-read on every remount otherwise; a stored photo never changes under its
 * filename, so the only invalidation is deletion.
 */
const cache = new Map<string, Promise<string>>();
const CACHE_SIZE = 48;

/** Read a stored photo back as a data URL (for `<img>` or a vision model). */
export function readPhotoDataUrl(filename: string): Promise<string> {
  const hit = cache.get(filename);
  if (hit) {
    // Re-insert so it counts as recently used.
    cache.delete(filename);
    cache.set(filename, hit);
    return hit;
  }
  const read = getDb()
    .then(() => invoke<string>("read_photo", { filename }))
    .then((base64) => `data:image/jpeg;base64,${base64}`);
  cache.set(filename, read);
  read.catch(() => cache.delete(filename));
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return read;
}

/** Delete a stored photo by filename. Never throws. */
export async function deletePhoto(filename: string): Promise<void> {
  cache.delete(filename);
  try {
    await getDb();
    await invoke("delete_photo", { filename });
  } catch (e) {
    console.warn("Failed to delete photo", filename, e);
  }
}
