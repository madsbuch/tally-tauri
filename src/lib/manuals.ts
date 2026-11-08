/**
 * Manuals: what works for this person in one situation, written up as a page.
 *
 * Memory and manuals divide the coach's knowledge by shape. Memory is single
 * observations — a goal, a commitment, a preference — and every one rides
 * along in every prompt. A manual gathers many observations about one
 * situation (a fast, a trip) into a page with sections, and is only loaded
 * when that situation is on: the prompt carries an index, the coach reads a
 * page with `read_manual`, and a manual tied to something the app can see
 * for itself (a running fast) arrives in full without being asked for.
 *
 * Who owns the words sits between the stance (theirs, never touched) and
 * memory (the coach's own notes): the coach writes and maintains manuals, the
 * person reads them and can edit them, and an edit of theirs is kept as they
 * wrote it. Every change keeps the version it replaced, so a rewrite by the
 * coach can always be checked against what was there.
 */
import { addManual, deleteManual, updateManual } from "./db";
import type { ManualDraft } from "./db";
import { cacheCoachPromptPrefix } from "./coach";
import type { Manual, ManualAuthor, ManualTrigger } from "./types";

export const MANUALS_CHANGED_EVENT = "tally:manuals-changed";

export const MANUAL_GLYPH = "📖";

/** How a detectable situation reads on screen. */
export const TRIGGER_LABELS: Record<ManualTrigger, string> = {
  fasting: "Opens while fasting",
};

export function isManualTrigger(v: unknown): v is ManualTrigger {
  return v === "fasting";
}

/** A manual's address: a page under the Coach tab. */
export function manualPath(id: number): string {
  return `/assistant/manuals/${id}`;
}

/** The manual id in a `:manualId` param, or null when it isn't one. */
export function parseManualId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function authorName(by: ManualAuthor): string {
  return by === "you" ? "you" : "the coach";
}

/** "Updated 8 Nov by the coach". */
export function updatedLabel(m: Pick<Manual, "updated_at" | "edited_by">): string {
  return `Updated ${shortDate(m.updated_at)} by ${authorName(m.edited_by)}`;
}

/** "8 Nov, by you" — how an earlier version is listed. */
export function writtenLabel(at: string, by: ManualAuthor): string {
  return `${shortDate(at)}, by ${authorName(by)}`;
}

export function notifyManualsChanged(): void {
  window.dispatchEvent(new CustomEvent(MANUALS_CHANGED_EVENT));
}

export function onManualsChanged(handler: () => void): () => void {
  window.addEventListener(MANUALS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(MANUALS_CHANGED_EVENT, handler);
}

/**
 * Every write goes through here: the index in the coach's prompt (and the
 * copy cached for the Android check-in) has to follow, and so does any
 * screen showing the list.
 */
async function changed(): Promise<void> {
  notifyManualsChanged();
  await cacheCoachPromptPrefix();
}

export async function createManual(draft: ManualDraft, by: ManualAuthor): Promise<number> {
  const id = await addManual(draft, by);
  await changed();
  return id;
}

export async function saveManual(
  id: number,
  draft: ManualDraft,
  by: ManualAuthor,
): Promise<boolean> {
  const ok = await updateManual(id, draft, by);
  if (ok) await changed();
  return ok;
}

export async function removeManual(id: number): Promise<void> {
  await deleteManual(id);
  await changed();
}
