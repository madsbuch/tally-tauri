/**
 * Progress photos: selfies taken now and then to see change the scale and the
 * tape don't show.
 *
 * Deliberately out of the way — reached only from a quiet link at the bottom
 * of Summary, so nothing shows them until you ask. They stay on this page:
 * not in the diary, not sent to a model, not read by the coach.
 */
import { useEffect, useRef, useState } from "react";
import { addProgressPhoto, deleteProgressPhoto, listProgressPhotos } from "../lib/db";
import { compressImage, readPhotoDataUrl, savePhoto } from "../lib/photos";
import { useUp } from "../lib/navigation";
import { useSheetHistory } from "../lib/sheetHistory";
import type { ProgressPhoto } from "../lib/types";
import InfoButton from "../components/InfoButton";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function longDate(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Whole days between two "YYYY-MM-DD" days. */
function daysBetween(from: string, to: string): number {
  const [y1 = 0, m1 = 1, d1 = 1] = from.split("-").map(Number);
  const [y2 = 0, m2 = 1, d2 = 1] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function since(first: string, day: string): string {
  const n = daysBetween(first, day);
  if (n <= 0) return "The first one";
  if (n < 14) return `${n} day${n === 1 ? "" : "s"} in`;
  if (n < 70) return `${Math.round(n / 7)} weeks in`;
  return `${Math.round(n / 30.4)} months in`;
}

function StoredImg({ filename, className }: { filename: string; className: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    readPhotoDataUrl(filename)
      .then((s) => {
        if (alive) setSrc(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filename]);
  if (!src) return <div className={className} />;
  return <img src={src} className={className} alt="Progress photo" />;
}

/** One photo, full size, with the first one beside it to compare against. */
function PhotoSheet({
  photo,
  first,
  onClose,
  onDeleted,
}: {
  photo: ProgressPhoto;
  first: ProgressPhoto | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  useSheetHistory(true, onClose);
  const [comparing, setComparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCompare = first !== null && first.id !== photo.id;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteProgressPhoto(photo);
      onDeleted();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">{longDate(photo.day)}</h2>
        {first && (
          <p className="muted small" style={{ margin: "-6px 0 12px" }}>
            {since(first.day, photo.day)}
          </p>
        )}

        {comparing && canCompare ? (
          <div className="progress-compare">
            <figure>
              <StoredImg filename={first.photo_path} className="progress-full" />
              <figcaption className="faint small">{longDate(first.day)}</figcaption>
            </figure>
            <figure>
              <StoredImg filename={photo.photo_path} className="progress-full" />
              <figcaption className="faint small">{longDate(photo.day)}</figcaption>
            </figure>
          </div>
        ) : (
          <StoredImg filename={photo.photo_path} className="progress-full" />
        )}

        {error && <div className="error-text">{error}</div>}

        <div className="btn-row" style={{ marginTop: 14 }}>
          {confirming ? (
            <>
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </button>
              <button className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
                {busy ? <span className="spinner" /> : "Delete for good"}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-danger" onClick={() => setConfirming(true)}>
                Delete
              </button>
              {canCompare && (
                <button className="btn" onClick={() => setComparing((c) => !c)}>
                  {comparing ? "Single" : "Compare"}
                </button>
              )}
              <button className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProgressPhotosPage() {
  const up = useUp();
  const [photos, setPhotos] = useState<ProgressPhoto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<ProgressPhoto | null>(null);
  const [refresh, setRefresh] = useState(0);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    listProgressPhotos()
      .then((p) => {
        if (alive) setPhotos(p);
      })
      .catch((e) => {
        if (alive) setLoadError(errMsg(e));
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>, fromCamera: boolean) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setSaving(true);
    try {
      const { base64 } = await compressImage(file, 1600, 0.85);
      const filename = await savePhoto(base64);
      // A photo picked from the gallery was taken when the file was made,
      // which is what puts an older one in its place in the timeline.
      const takenAt =
        !fromCamera && file.lastModified > 0
          ? new Date(file.lastModified).toISOString()
          : new Date().toISOString();
      await addProgressPhoto(filename, takenAt);
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(`Could not save that photo: ${errMsg(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const first = photos && photos.length > 0 ? photos[photos.length - 1]! : null;

  return (
    <div className="page page-with-fab">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Progress
          <InfoButton title="Progress photos">
            <p>
              A selfie every week or two shows change the scale doesn&apos;t:
              same spot, same light, same pose makes it easiest to see.
            </p>
            <p>
              They&apos;re only ever shown here. They aren&apos;t in your diary,
              aren&apos;t sent to the AI model, and the coach doesn&apos;t see
              them. They are part of the database export.
            </p>
          </InfoButton>
        </h1>
        <button className="btn btn-ghost btn-sm" onClick={up}>
          ‹ Summary
        </button>
      </header>

      {loadError && <div className="error-text">{loadError}</div>}
      {error && <div className="error-text">{error}</div>}

      {photos === null && !loadError && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {photos !== null && photos.length === 0 && (
        <div className="empty">
          <div className="empty-icon">🤳</div>
          No photos yet.
          <div className="faint small" style={{ marginTop: 4 }}>
            Take the first one below. It&apos;s the one you&apos;ll compare against.
          </div>
        </div>
      )}

      {photos !== null && photos.length > 0 && (
        <div className="progress-grid">
          {photos.map((p) => (
            <button key={p.id} className="progress-cell" onClick={() => setOpen(p)}>
              <StoredImg filename={p.photo_path} className="progress-thumb" />
              <span className="faint small">{longDate(p.day)}</span>
            </button>
          ))}
        </div>
      )}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="user"
        style={{ display: "none" }}
        onChange={(e) => void onPick(e, true)}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => void onPick(e, false)}
      />

      <div className="fab-stack">
        <button
          className="fab fab-secondary"
          onClick={() => galleryRef.current?.click()}
          disabled={saving}
          aria-label="Add from gallery"
          title="Add from gallery"
        >
          🖼
        </button>
        <button className="fab" onClick={() => cameraRef.current?.click()} disabled={saving}>
          {saving ? <span className="spinner" /> : "🤳 Selfie"}
        </button>
      </div>

      {open && (
        <PhotoSheet
          photo={open}
          first={first}
          onClose={() => setOpen(null)}
          onDeleted={() => {
            setOpen(null);
            setRefresh((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
