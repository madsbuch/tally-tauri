/**
 * The document library: photographed blood results, scan reports, letters.
 *
 * Same shape as the diary's capture pipeline — the row is written instantly
 * and read in the background — because the alternative is a spinner between
 * the user and their own filing cabinet. A document is usable (viewable,
 * titled, dated by hand) the moment it's added; the reading only fills in the
 * parts that make it useful to the coach.
 *
 * Reading happens once, at upload. Every later conversation then works from
 * text: cheap, searchable, and available to the scheduled check-in, which has
 * no vision call of its own.
 */
import {
  addDocument,
  deleteDocument,
  deletePhotoIfUnused,
  getDocument,
  getSetting,
  listPendingDocuments,
  todayStr,
  updateDocument,
} from "./db";
import { analyzeDocument } from "./openrouter";
import { readPhotoDataUrl, savePhoto } from "./photos";
import { withBackgroundTask } from "./background";
import { onAppResume, wasSuspendedSince } from "./appLifecycle";
import { cacheCoachPromptPrefix } from "./coach";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "./types";
import type { LibraryDocument } from "./types";

export const LIBRARY_CHANGED_EVENT = "tally:library-changed";

/**
 * A document's pages, in order.
 *
 * `page_paths` is the full list, but documents filed before PDFs were
 * supported have only `photo_path` — so that's the fallback rather than a
 * migration that would have to guess.
 */
export function documentPages(doc: LibraryDocument): string[] {
  if (doc.page_paths.length > 0) return doc.page_paths;
  return doc.photo_path ? [doc.photo_path] : [];
}

export function notifyLibraryChanged(): void {
  window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT));
}

export function onLibraryChanged(handler: () => void): () => void {
  window.addEventListener(LIBRARY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, handler);
}

const inFlight = new Set<number>();

async function readDocument(doc: LibraryDocument): Promise<void> {
  const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey);
  if (!apiKey) throw new Error("Add your OpenRouter API key in Settings first");
  const pages = documentPages(doc);
  if (pages.length === 0) throw new Error("This document has no image to read");
  const model = (await getSetting(SETTING_KEYS.visionModel)) || DEFAULT_VISION_MODEL;

  // Read through Rust: fetching the asset URL is CSP-blocked on Android.
  // Sequentially, because a multi-page PDF is several megabytes of base64 and
  // holding all of it plus the parallel copies at once is what runs a phone
  // out of memory.
  const imageDataUrls: string[] = [];
  for (const page of pages) imageDataUrls.push(await readPhotoDataUrl(page));

  const analysis = await analyzeDocument({
    apiKey,
    model,
    imageDataUrls,
    note: doc.note ?? undefined,
    today: todayStr(),
  });

  await updateDocument(doc.id, {
    title: analysis.title,
    kind: analysis.kind,
    // No legible date on the page: fall back to the day it was added, so it
    // still files somewhere sensible and can be corrected by hand.
    document_date: analysis.document_date ?? todayStr(new Date(doc.created_at)),
    summary: analysis.summary || null,
    extracted: analysis.values,
    status: "ready",
    error: null,
    model_id: model,
  });
}

async function processDocument(id: number): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  const startedAt = Date.now();
  try {
    const doc = await getDocument(id);
    if (!doc) return;
    try {
      await withBackgroundTask("Reading your document", () => readDocument(doc));
      notifyLibraryChanged();
      // A new result is part of what the coach knows, and the scheduled
      // check-in reads that from the cached prefix.
      void cacheCoachPromptPrefix();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Suspended mid-read is not a failure: keep it pending so returning to
      // the app picks it up, rather than leaving an error to clear by hand.
      if (wasSuspendedSince(startedAt)) {
        await updateDocument(id, { status: "pending", error: null });
      } else {
        await updateDocument(id, { status: "error", error: msg });
      }
      notifyLibraryChanged();
    }
  } finally {
    inFlight.delete(id);
  }
}

export interface AddDocumentOptions {
  /** Base64 JPEG payloads, one per page, in order (compressImage / pdf.ts). */
  pagesBase64: string[];
  /** Optional context the user typed — often the only clue to what it is. */
  note?: string | undefined;
}

/**
 * File a document and start reading it. Returns as soon as it's stored, so
 * the library shows it immediately.
 */
export async function addLibraryDocument(opts: AddDocumentOptions): Promise<number> {
  if (opts.pagesBase64.length === 0) throw new Error("Nothing to file");
  const pagePaths: string[] = [];
  for (const page of opts.pagesBase64) pagePaths.push(await savePhoto(page));
  const id = await addDocument({
    // Replaced by the model's title once it's been read.
    title: opts.note?.trim() || "Untitled document",
    note: opts.note?.trim() || null,
    page_paths: pagePaths,
  });
  notifyLibraryChanged();
  void processDocument(id);
  return id;
}

/** Re-read a document whose first attempt failed. */
export async function retryDocument(id: number): Promise<void> {
  await updateDocument(id, { status: "pending", error: null });
  notifyLibraryChanged();
  void processDocument(id);
}

/** Remove a document and every page of it. */
export async function removeDocument(doc: LibraryDocument): Promise<void> {
  await deleteDocument(doc.id);
  for (const page of documentPages(doc)) await deletePhotoIfUnused(page);
  notifyLibraryChanged();
  void cacheCoachPromptPrefix();
}

/** Pick up documents whose reading was interrupted (call on app start). */
export async function resumePendingDocuments(): Promise<void> {
  for (const doc of await listPendingDocuments()) {
    void processDocument(doc.id);
  }
}

/** Re-run interrupted readings whenever the app returns to the foreground. */
export function installDocumentLifecycle(): () => void {
  return onAppResume(() => void resumePendingDocuments());
}
