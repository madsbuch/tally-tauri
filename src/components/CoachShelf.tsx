/**
 * The Coach tab's shelf: what the coach knows, one tap from its chats.
 *
 * Three tiles rather than three rows, so the suggestions and recent chats —
 * what the tab is mostly for — stay near the top. Each tile carries a count
 * that's worth a glance on its own: follow-ups that have come due, how many
 * manuals there are, how much is in the library.
 */
import { useEffect, useState } from "react";
import { listCoachMemory, listDocuments, listManuals } from "../lib/db";
import { dueFollowUpCount } from "../lib/coach";
import { MANUAL_GLYPH, onManualsChanged } from "../lib/manuals";
import { onLibraryChanged } from "../lib/documents";
import { Link } from "../router";

interface Counts {
  manuals: number;
  memory: number;
  due: number;
  documents: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function CoachShelf() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      listManuals().catch(() => []),
      listCoachMemory().catch(() => []),
      listDocuments().catch(() => []),
    ]).then(([manuals, memory, documents]) => {
      if (!alive) return;
      setCounts({
        manuals: manuals.length,
        memory: memory.length,
        due: dueFollowUpCount(memory),
        documents: documents.length,
      });
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  useEffect(() => {
    const bump = () => setRefresh((n) => n + 1);
    const offManuals = onManualsChanged(bump);
    const offLibrary = onLibraryChanged(bump);
    return () => {
      offManuals();
      offLibrary();
    };
  }, []);

  const sub = (s: string) => (counts === null ? " " : s);

  return (
    <div className="coach-shelf">
      <Link to="/assistant/manuals" className="coach-tile">
        <span className="coach-tile-icon">{MANUAL_GLYPH}</span>
        <span className="coach-tile-title">Manuals</span>
        <span className="coach-tile-sub">
          {sub(counts?.manuals ? plural(counts.manuals, "manual") : "None yet")}
        </span>
      </Link>
      <Link to="/assistant/memory" className="coach-tile">
        <span className="coach-tile-icon">🧠</span>
        <span className="coach-tile-title">Memory</span>
        <span className={`coach-tile-sub${counts?.due ? " coach-tile-due" : ""}`}>
          {sub(
            counts?.due
              ? `${counts.due} due`
              : counts?.memory
                ? plural(counts.memory, "item")
                : "Empty",
          )}
        </span>
      </Link>
      <Link to="/assistant/library" className="coach-tile">
        <span className="coach-tile-icon">🗄</span>
        <span className="coach-tile-title">Library</span>
        <span className="coach-tile-sub">
          {sub(counts?.documents ? plural(counts.documents, "doc") : "Empty")}
        </span>
      </Link>
    </div>
  );
}
