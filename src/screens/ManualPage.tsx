/**
 * One manual: read it, edit it, look back at what it said before.
 *
 * Reading is the default — that's what you open it for, usually in the
 * middle of the situation it's about. Editing is a deliberate step, and a
 * save marks the page as yours so the coach keeps your lines as you wrote
 * them. Every change, the coach's or yours, keeps the version it replaced.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getManual, listManualRevisions } from "../lib/db";
import type { Manual, ManualRevision, ManualTrigger } from "../lib/types";
import {
  TRIGGER_LABELS,
  isManualTrigger,
  onManualsChanged,
  parseManualId,
  removeManual,
  saveManual,
  updatedLabel,
  writtenLabel,
} from "../lib/manuals";
import { useGo, useUp } from "../lib/navigation";

interface Draft {
  title: string;
  situation: string;
  applies_when: ManualTrigger | null;
  body: string;
}

function Editor({
  manual,
  onDone,
}: {
  manual: Manual;
  onDone: (saved: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    title: manual.title,
    situation: manual.situation,
    applies_when: manual.applies_when,
    body: manual.body,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = {
      title: draft.title.trim(),
      situation: draft.situation.trim(),
      applies_when: draft.applies_when,
      body: draft.body.trim(),
    };
    if (!next.title || !next.situation || !next.body) {
      setError("A manual needs a title, a situation and something in it.");
      return;
    }
    setSaving(true);
    try {
      await saveManual(manual.id, next, "you");
      onDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="field">
        <label className="label" htmlFor="manual-title">Title</label>
        <input
          id="manual-title"
          className="input"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="manual-situation">When it applies</label>
        <input
          id="manual-situation"
          className="input"
          value={draft.situation}
          onChange={(e) => setDraft({ ...draft, situation: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="manual-trigger">Open automatically</label>
        <select
          id="manual-trigger"
          className="input"
          value={draft.applies_when ?? "none"}
          onChange={(e) =>
            setDraft({
              ...draft,
              applies_when: isManualTrigger(e.target.value) ? e.target.value : null,
            })
          }
        >
          <option value="none">No, the coach decides</option>
          <option value="fasting">While I&apos;m fasting</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="manual-body">Manual (markdown)</label>
        <textarea
          id="manual-body"
          className="input manual-editor"
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="input-row">
        <button className="btn" onClick={() => onDone(false)} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? <span className="spinner" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

function History({ revisions }: { revisions: ManualRevision[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (revisions.length === 0) return null;
  return (
    <details className="memory-group">
      <summary className="section-title">
        Earlier versions <span className="memory-count">{revisions.length}</span>
      </summary>
      <div className="list">
        {revisions.map((r) => (
          <div key={r.id} className="card" style={{ marginBottom: 0 }}>
            <button
              className="chat-suggestion"
              style={{ background: "none", border: "none", padding: 0 }}
              onClick={() => setOpen(open === r.id ? null : r.id)}
            >
              <div className="row-title">{r.title}</div>
              <div className="row-sub">{writtenLabel(r.written_at, r.edited_by)}</div>
            </button>
            {open === r.id && (
              <div className="chat-md manual-body" style={{ marginTop: 10 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.body}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

export default function ManualPage() {
  const id = parseManualId(useParams()["manualId"]);
  const [loaded, setLoaded] = useState<Manual | null | undefined>(undefined);
  const manual = id === null ? null : loaded;
  const [revisions, setRevisions] = useState<ManualRevision[]>([]);
  const [editing, setEditing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const up = useUp();
  const go = useGo();

  useEffect(() => {
    let alive = true;
    if (id === null) return;
    void Promise.all([getManual(id), listManualRevisions(id)])
      .then(([m, r]) => {
        if (!alive) return;
        setLoaded(m);
        setRevisions(r);
      })
      .catch(() => {
        if (alive) setLoaded(null);
      });
    return () => {
      alive = false;
    };
  }, [id, refresh]);

  // The coach may rewrite it while it's open.
  useEffect(() => onManualsChanged(() => setRefresh((n) => n + 1)), []);

  async function remove() {
    if (!manual) return;
    if (!window.confirm(`Delete “${manual.title}” and its history?`)) return;
    await removeManual(manual.id);
    go("/assistant/manuals");
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{manual?.title ?? "Manual"}</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => go("/assistant/manuals")}>
          ‹ Manuals
        </button>
      </header>

      {manual === undefined && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {manual === null && (
        <div className="empty">
          <div className="empty-icon">📖</div>
          This manual is gone.
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-sm" onClick={up}>
              Back to Coach
            </button>
          </div>
        </div>
      )}

      {manual && editing && (
        <Editor
          manual={manual}
          onDone={(saved) => {
            setEditing(false);
            if (saved) setRefresh((n) => n + 1);
          }}
        />
      )}

      {manual && !editing && (
        <>
          <p className="muted small" style={{ margin: "0 2px 6px" }}>
            {manual.situation}
          </p>
          <div className="chips" style={{ margin: "0 0 12px" }}>
            {manual.applies_when && (
              <span className="chip chip-accent">{TRIGGER_LABELS[manual.applies_when]}</span>
            )}
            <span className="chip">{updatedLabel(manual)}</span>
          </div>
          <div className="card">
            <div className="chat-md manual-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{manual.body}</ReactMarkdown>
            </div>
          </div>
          <div className="input-row">
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn btn-danger" onClick={() => void remove()}>
              Delete
            </button>
          </div>
          <History revisions={revisions} />
        </>
      )}
    </div>
  );
}
