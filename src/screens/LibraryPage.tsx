/**
 * The document library.
 *
 * A document is a stack of page images: a photograph is one page, a PDF is one
 * per page (see lib/pdf.ts), and the model reads them together so a four-page
 * blood panel becomes one entry rather than four.
 *
 * Filed by the date on the document rather than the day it was photographed,
 * so a result from March reads as March. The model pulls that date off the
 * page; when there isn't one it falls back to the day it was added, and the
 * date is editable either way — a misread date puts a result in the wrong
 * place in your history, which is worse than no date at all.
 */
import { useEffect, useRef, useState } from "react";
import { listDocuments } from "../lib/db";
import type { DocumentValue, LibraryDocument } from "../lib/types";
import {
  addLibraryDocument,
  documentPages,
  onLibraryChanged,
  removeDocument,
  retryDocument,
} from "../lib/documents";
import { updateDocument } from "../lib/db";
import { compressImage, photoSrc } from "../lib/photos";
import { MAX_PDF_PAGES, isPdf, pdfToImages } from "../lib/pdf";
import InfoButton from "../components/InfoButton";

const KIND_LABELS: Record<LibraryDocument["kind"], string> = {
  lab: "Lab result",
  imaging: "Imaging",
  report: "Report",
  note: "Note",
  other: "Document",
};

const KIND_GLYPHS: Record<LibraryDocument["kind"], string> = {
  lab: "🩸",
  imaging: "🩻",
  report: "📄",
  note: "📝",
  other: "📎",
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortDate(day: string | null): string {
  if (!day) return "No date";
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Stored image, resolved to a displayable URL asynchronously. */
function PhotoImg({ filename, className }: { filename: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void photoSrc(filename).then((s) => {
      if (alive) setSrc(s);
    });
    return () => {
      alive = false;
    };
  }, [filename]);
  if (!src) return <div className={className} />;
  return <img src={src} className={className} alt="Document" />;
}

/**
 * A document's pages, whole rather than cropped.
 *
 * Only the first is shown until asked: a four-page PDF is two thousand pixels
 * of scrolling between the sheet's handle and the measurements, which are what
 * the sheet is actually for.
 */
function PageStack({ pages }: { pages: { key: string; node: React.ReactNode }[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? pages : pages.slice(0, 1);
  return (
    <div className="doc-pages">
      {shown.map((p, i) => (
        <div key={p.key}>
          {pages.length > 1 && (
            <div className="faint small doc-page-label">
              Page {i + 1} of {pages.length}
            </div>
          )}
          {p.node}
        </div>
      ))}
      {pages.length > 1 && (
        <button
          className="btn btn-sm doc-pages-toggle"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show first page only" : `Show all ${pages.length} pages`}
        </button>
      )}
    </div>
  );
}

function ValueRow({ v }: { v: DocumentValue }) {
  const off = v.flag === "low" || v.flag === "high";
  return (
    <div className="doc-value">
      <span className="doc-value-name">{v.name}</span>
      <span className={`doc-value-figure${off ? " doc-value-off" : ""}`}>
        {v.value}
        {v.unit ? ` ${v.unit}` : ""}
        {off ? ` ${v.flag === "low" ? "↓" : "↑"}` : ""}
      </span>
      {v.reference && <span className="doc-value-ref">{v.reference}</span>}
    </div>
  );
}

function DocumentSheet({
  doc,
  onClose,
  onChanged,
}: {
  doc: LibraryDocument;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [date, setDate] = useState(doc.document_date ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const flagged = doc.extracted.filter((v) => v.flag === "low" || v.flag === "high");
  const shown = showAll || flagged.length === 0 ? doc.extracted : flagged;
  const pages = documentPages(doc);

  async function save() {
    const t = title.trim();
    if (!t) {
      setError("Give it a title.");
      return;
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a valid date.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateDocument(doc.id, { title: t, document_date: date || null });
      onChanged();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await removeDocument(doc);
      onChanged();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        {pages.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <PageStack
              pages={pages.map((f) => ({
                key: f,
                node: <PhotoImg filename={f} className="doc-page" />,
              }))}
            />
          </div>
        )}

        <div className="field">
          <label className="label">Title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" style={{ display: "flex", alignItems: "center", gap: 2 }}>
            Date on the document
            <InfoButton title="Date on the document">
              <p>
                What the document is filed under — the day the sample was taken,
                not the day you added it.
              </p>
              <p>
                It&apos;s read off the page where there is one. Correcting it here
                moves the document in your history.
              </p>
            </InfoButton>
          </label>
          <input
            className="input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {doc.summary && (
          <p className="muted small" style={{ margin: "0 2px 12px" }}>
            {doc.summary}
          </p>
        )}

        {doc.extracted.length > 0 && (
          <>
            <div className="label" style={{ marginBottom: 6 }}>
              {flagged.length > 0 && !showAll
                ? `Outside range (${flagged.length} of ${doc.extracted.length})`
                : `Measurements (${doc.extracted.length})`}
            </div>
            <div className="doc-values">
              {shown.map((v, i) => (
                <ValueRow key={`${v.name}-${i}`} v={v} />
              ))}
            </div>
            {flagged.length > 0 && doc.extracted.length > flagged.length && (
              <button
                className="btn btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setShowAll((s) => !s)}
              >
                {showAll ? "Only what's off" : `Show all ${doc.extracted.length}`}
              </button>
            )}
          </>
        )}

        {doc.status === "error" && (
          <div className="error-text" style={{ marginTop: 12 }}>
            {doc.error || "Reading this document failed."}
          </div>
        )}
        {error && (
          <div className="error-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
            Delete
          </button>
          {doc.status === "error" && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                void retryDocument(doc.id);
                onClose();
              }}
            >
              Read again
            </button>
          )}
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? <span className="spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [pages, setPages] = useState<{ dataUrl: string; base64: string }[]>([]);
  /** Pages a long PDF had beyond the cap, so the sheet can say they're gone. */
  const [dropped, setDropped] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      if (isPdf(file)) {
        // A PDF becomes page images like any other document: the same viewer,
        // the same vision model, no second path through the app.
        const { pages: rendered, totalPages } = await pdfToImages(file);
        if (rendered.length === 0) throw new Error("It has no pages.");
        setPages(rendered);
        setDropped(totalPages - rendered.length);
      } else {
        // Documents are read for small print, so they keep more detail than a
        // meal photo needs.
        setPages([await compressImage(file, 2000, 0.9)]);
        setDropped(0);
      }
    } catch (err) {
      setPages([]);
      setDropped(0);
      setError(`Could not read that file: ${errMsg(err)}`);
    } finally {
      setReading(false);
    }
  }

  async function add() {
    if (pages.length === 0) {
      setError("Take a photo or pick a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addLibraryDocument({ pagesBase64: pages.map((p) => p.base64), note });
      onSaved();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Add to library
          <InfoButton title="Adding a document">
            <p>
              A PDF comes in as one image per page. Photograph a paper result and
              it&apos;s the same thing with one page.
            </p>
            <p>
              It gets read in the background — the date, what was measured, and
              which values sit outside their range. You can correct any of it
              afterwards.
            </p>
          </InfoButton>
        </h2>

        {reading && (
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}
          >
            <span className="spinner" />
            <span className="muted small">Rendering the pages…</span>
          </div>
        )}

        {pages.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <PageStack
              pages={pages.map((p, i) => ({
                key: `${i}`,
                node: (
                  <img
                    src={p.dataUrl}
                    className="doc-page"
                    alt={`Page ${i + 1} preview`}
                  />
                ),
              }))}
            />
            {dropped > 0 && (
              <p className="faint small" style={{ margin: "8px 2px 0" }}>
                Only the first {MAX_PDF_PAGES} pages are kept — {dropped} more
                weren&apos;t.
              </p>
            )}
          </div>
        )}

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => void onPick(e)}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: "none" }}
          onChange={(e) => void onPick(e)}
        />

        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button
            className="btn"
            onClick={() => cameraRef.current?.click()}
            disabled={reading}
          >
            📷 Photograph
          </button>
          <button
            className="btn"
            onClick={() => galleryRef.current?.click()}
            disabled={reading}
          >
            📄 Image or PDF
          </button>
        </div>

        <div className="field">
          <label className="label">Anything worth knowing (optional)</label>
          <textarea
            className="input"
            rows={2}
            placeholder="e.g. follow-up panel after starting iron"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>


        {error && <div className="error-text">{error}</div>}

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void add()}
            disabled={busy || reading || pages.length === 0}
          >
            {busy ? <span className="spinner" /> : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LibraryPage() {
  const [docs, setDocs] = useState<LibraryDocument[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<LibraryDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    listDocuments()
      .then((d) => {
        if (alive) setDocs(d);
      })
      .catch((e) => {
        if (alive) setLoadError(errMsg(e));
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  // Readings finish in the background; the list follows them.
  useEffect(() => onLibraryChanged(() => setRefresh((n) => n + 1)), []);

  const bump = () => setRefresh((n) => n + 1);

  return (
    <div className="page page-with-fab">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Library
          <InfoButton title="Library">
            <p>
              Blood results, scan reports, letters. Photograph one or add a PDF
              and it&apos;s read in the background — the date, what was measured,
              and which values sit outside their range.
            </p>
            <p>
              Each is filed under the date printed on it rather than the day you
              added it, so a result from March reads as March. Your coach can
              read the measurements off them.
            </p>
          </InfoButton>
        </h1>
      </header>

      {loadError && <div className="error-text">{loadError}</div>}

      {docs === null && !loadError && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {docs !== null && docs.length === 0 && (
        <div className="empty">
          <div className="empty-icon">🗄</div>
          Nothing filed yet.
          <div className="faint small" style={{ marginTop: 4 }}>
            Photograph your next blood test with ＋ Add below.
          </div>
        </div>
      )}

      {docs !== null && docs.length > 0 && (
        <div className="list">
          {docs.map((d) => (
            <div
              key={d.id}
              className="list-row"
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() => setDetail(d)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setDetail(d);
              }}
            >
              {d.photo_path ? (
                <PhotoImg filename={d.photo_path} className="photo-thumb" />
              ) : (
                <div className="photo-thumb" />
              )}
              <div className="row-main">
                <div className="row-title">{d.title}</div>
                <div className="row-sub">
                  {shortDate(d.document_date)} · {KIND_LABELS[d.kind]}
                  {documentPages(d).length > 1
                    ? ` · ${documentPages(d).length} pages`
                    : ""}
                </div>
                {d.status === "pending" && (
                  <div
                    className="row-sub"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span
                      className="spinner"
                      style={{ width: 12, height: 12, flex: "0 0 auto" }}
                    />
                    <span className="muted">Reading…</span>
                  </div>
                )}
                {d.status === "error" && (
                  <div className="chips" style={{ marginTop: 6 }}>
                    <span className="chip chip-warn">Couldn&apos;t read it</span>
                  </div>
                )}
                {d.status === "ready" && d.extracted.length > 0 && (
                  <div className="chips" style={{ marginTop: 6 }}>
                    {(() => {
                      const off = d.extracted.filter(
                        (v) => v.flag === "low" || v.flag === "high",
                      ).length;
                      return (
                        <>
                          <span className="chip">
                            {d.extracted.length} value
                            {d.extracted.length === 1 ? "" : "s"}
                          </span>
                          {off > 0 && (
                            <span className="chip chip-warn">{off} outside range</span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
              <div className="row-end">{KIND_GLYPHS[d.kind]}</div>
            </div>
          ))}
        </div>
      )}

      <div className="fab-stack">
        <button className="fab" onClick={() => setAdding(true)}>
          ＋ Add
        </button>
      </div>

      {adding && (
        <AddSheet
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            bump();
          }}
        />
      )}
      {detail && (
        <DocumentSheet
          doc={detail}
          onClose={() => setDetail(null)}
          onChanged={bump}
        />
      )}
    </div>
  );
}
