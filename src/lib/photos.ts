import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

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

/** Persist a base64 JPEG via the Rust backend; returns the stored filename. */
export function savePhoto(base64: string): Promise<string> {
  return invoke<string>("save_photo", { dataBase64: base64 });
}

/**
 * Read a stored photo back as a data URL, via Rust. (Fetching the asset URL
 * from the WebView is blocked by CSP connect-src on Android.)
 */
export async function readPhotoDataUrl(filename: string): Promise<string> {
  const base64 = await invoke<string>("read_photo", { filename });
  return `data:image/jpeg;base64,${base64}`;
}

/** Delete a stored photo by filename. Never throws. */
export async function deletePhoto(filename: string): Promise<void> {
  try {
    await invoke("delete_photo", { filename });
  } catch (e) {
    console.warn("Failed to delete photo", filename, e);
  }
}

let photosDirPromise: Promise<string> | null = null;

function photosDir(): Promise<string> {
  if (!photosDirPromise) {
    photosDirPromise = appDataDir().then((dir) => join(dir, "photos"));
  }
  return photosDirPromise;
}

/** Resolve a stored photo filename to a webview-displayable URL. */
export async function photoSrc(filename: string): Promise<string> {
  const dir = await photosDir();
  return convertFileSrc(await join(dir, filename));
}
