/**
 * Small pieces the diary and the entry page both draw with.
 *
 * They lived inside DiaryPage until an entry got a page of its own; nothing
 * here knows about either screen.
 */
import { useEffect, useState } from "react";
import { photoSrc } from "../lib/photos";
import {
  SYNCED_WORKOUT_GLYPH,
  WORKOUT_FALLBACK_GLYPH,
  entryGlyph,
  guessIconKey,
  iconGlyph,
  iconsFor,
} from "../lib/icons";
import type { IconKind } from "../lib/icons";
import type { Workout } from "../lib/types";

/** Resolves a stored photo filename to a displayable <img>. */
export function PhotoImg({
  filename,
  className,
  alt,
}: {
  filename: string;
  className: string;
  alt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    photoSrc(filename)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filename]);
  if (!src) return <div className={className} />;
  return <img src={src} className={className} alt={alt} />;
}

/** Emoji glyph in a photo-thumb-sized rounded square. */
export function GlyphThumb({ glyph }: { glyph: string }) {
  return (
    <div
      className="photo-thumb"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 22,
      }}
    >
      {glyph}
    </div>
  );
}

/**
 * The glyph for a photo-less workout row. Synced sessions fall back to the
 * watch marker only when their title says nothing useful — "Morning run"
 * deserves 🏃 whether it came from Garmin or was typed in by hand.
 */
export function workoutGlyph(w: Workout): string {
  return (
    iconGlyph(w.icon) ??
    iconGlyph(guessIconKey(w.title, "workout")) ??
    (w.source ? SYNCED_WORKOUT_GLYPH : WORKOUT_FALLBACK_GLYPH)
  );
}

/**
 * The glyph an entry shows when it has no photo. "auto" leaves it to the
 * title-keyword guess in lib/icons.ts, which is what a fresh entry gets.
 */
export function IconPicker({
  kind,
  title,
  value,
  onChange,
}: {
  kind: IconKind;
  title: string;
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  return (
    <div className="field">
      <label className="label">Icon</label>
      <div className="icon-picker">
        <button
          type="button"
          className={`icon-opt${value === null ? " icon-opt-active" : ""}`}
          onClick={() => onChange(null)}
          title="Automatic — matched from the title"
          aria-label="Automatic icon"
        >
          <span>{entryGlyph(null, title, kind)}</span>
          <span className="icon-opt-auto">auto</span>
        </button>
        {iconsFor(kind).map((i) => (
          <button
            type="button"
            key={i.key}
            className={`icon-opt${value === i.key ? " icon-opt-active" : ""}`}
            onClick={() => onChange(i.key)}
            title={i.label}
            aria-label={i.label}
          >
            <span>{i.glyph}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A number as an editable string: "48", "0.5" — never "48.00000001". */
export function numToInput(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** "7 h 20 min", "45 min", or null when there's nothing to show. */
export function fmtDuration(min: number | null): string | null {
  if (min == null || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
