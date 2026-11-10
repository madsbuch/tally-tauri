/**
 * The Coach tab's shelf: what the coach knows, one tap from its chats.
 *
 * Two rows. The first is the coach's own working knowledge — manuals (what
 * works), memory (what it noted), experiments (what's being tested) — as
 * three tiles, so the chats below stay near the top. The library, the
 * outside evidence, gets the full width beneath. Each carries a count worth
 * a glance on its own: follow-ups come due, trials waiting for a rating.
 */
import { useEffect, useState } from "react";
import {
  listCoachMemory,
  listDocuments,
  listExperiments,
  listManuals,
  listTrials,
} from "../lib/db";
import { dueFollowUpCount } from "../lib/coach";
import { MANUAL_GLYPH, onManualsChanged } from "../lib/manuals";
import { onLibraryChanged } from "../lib/documents";
import { EXPERIMENT_GLYPH, needsRating, onExperimentsChanged } from "../lib/experiments";
import { Link } from "../router";

interface Counts {
  manuals: number;
  memory: number;
  due: number;
  documents: number;
  running: number;
  toRate: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function experimentCounts(): Promise<{ running: number; toRate: number }> {
  const running = (await listExperiments()).filter((e) => e.status === "running");
  let toRate = 0;
  for (const e of running) {
    toRate += (await listTrials(e.id)).filter((t) => needsRating(e, t)).length;
  }
  return { running: running.length, toRate };
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
      experimentCounts().catch(() => ({ running: 0, toRate: 0 })),
    ]).then(([manuals, memory, documents, experiments]) => {
      if (!alive) return;
      setCounts({
        manuals: manuals.length,
        memory: memory.length,
        due: dueFollowUpCount(memory),
        documents: documents.length,
        ...experiments,
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
    const offExperiments = onExperimentsChanged(bump);
    return () => {
      offManuals();
      offLibrary();
      offExperiments();
    };
  }, []);

  const sub = (s: string) => (counts === null ? " " : s);

  return (
    <div className="coach-shelf">
      <div className="coach-shelf-row">
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
        <Link to="/assistant/experiments" className="coach-tile">
          <span className="coach-tile-icon">{EXPERIMENT_GLYPH}</span>
          <span className="coach-tile-title">Experiments</span>
          <span className={`coach-tile-sub${counts?.toRate ? " coach-tile-due" : ""}`}>
            {sub(
              counts?.toRate
                ? `${counts.toRate} to rate`
                : counts?.running
                  ? `${counts.running} running`
                  : "None yet",
            )}
          </span>
        </Link>
      </div>
      <Link to="/assistant/library" className="coach-tile coach-tile-wide">
        <span className="coach-tile-icon">🗄</span>
        <span className="coach-tile-main">
          <span className="coach-tile-title">Library</span>
          <span className="coach-tile-sub">
            {sub(
              counts?.documents
                ? `${plural(counts.documents, "document")} the coach can read`
                : "Blood results and reports the coach can read",
            )}
          </span>
        </span>
        <span className="faint">›</span>
      </Link>
    </div>
  );
}
