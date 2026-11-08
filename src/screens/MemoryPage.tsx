/**
 * What the coach remembers, on a page of its own.
 *
 * It used to sit at the bottom of Settings, but it isn't a setting: the coach
 * writes it, and you read it and strike out what's wrong. Here it's ordered
 * by what the coach is about to act on — follow-ups and open commitments
 * first — with the rest grouped by kind underneath.
 */
import { useEffect, useState } from "react";
import { deleteCoachMemory, listCoachMemory, todayStr } from "../lib/db";
import { cacheCoachPromptPrefix } from "../lib/coach";
import type { CoachMemory } from "../lib/types";
import InfoButton from "../components/InfoButton";
import { useUp } from "../lib/navigation";

function shortDay(day: string): string {
  const [y = 0, m = 1, d = 1] = day.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Memories the coach will raise or is holding them to, soonest first. */
function onItsRadar(memory: CoachMemory[]): CoachMemory[] {
  return memory
    .filter((m) => m.follow_up_on != null || (m.kind === "commitment" && m.status === "open"))
    .sort((a, b) => (a.follow_up_on ?? "9999").localeCompare(b.follow_up_on ?? "9999"));
}

const GROUPS: { title: string; pick: (m: CoachMemory) => boolean }[] = [
  { title: "Goals", pick: (m) => m.kind === "goal" },
  { title: "Preferences", pick: (m) => m.kind === "preference" },
  { title: "Notes", pick: (m) => m.kind === "note" },
  { title: "Settled commitments", pick: (m) => m.kind === "commitment" && m.status !== "open" },
];

function MemoryRow({
  m,
  today,
  onForget,
}: {
  m: CoachMemory;
  today: string;
  onForget: (id: number) => void;
}) {
  const parts: string[] = [];
  if (m.kind === "commitment") parts.push(m.status === "open" ? "Commitment" : `Commitment · ${m.status}`);
  if (m.follow_up_on) {
    parts.push(m.follow_up_on <= today ? "Follow-up due" : `Follows up ${shortDay(m.follow_up_on)}`);
  }
  parts.push(`Updated ${shortDay(m.updated_at)}`);
  return (
    <div className="list-row">
      <div className="row-main">
        <div className="row-title" style={{ whiteSpace: "normal" }}>
          {m.text}
        </div>
        <div className="row-sub">{parts.join(" · ")}</div>
      </div>
      <button
        className="btn btn-ghost btn-sm row-end"
        aria-label="Forget this"
        onClick={() => onForget(m.id)}
      >
        ✕
      </button>
    </div>
  );
}

export default function MemoryPage() {
  const [memory, setMemory] = useState<CoachMemory[] | null>(null);
  const up = useUp();
  const today = todayStr();

  useEffect(() => {
    let alive = true;
    listCoachMemory()
      .then((m) => {
        if (alive) setMemory(m);
      })
      .catch(() => {
        if (alive) setMemory([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function forget(id: number) {
    await deleteCoachMemory(id);
    setMemory(await listCoachMemory());
    await cacheCoachPromptPrefix();
  }

  const radar = memory ? onItsRadar(memory) : [];
  const radarIds = new Set(radar.map((m) => m.id));

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Memory
          <InfoButton title="Memory">
            <p>
              What the coach has picked up about you: goals, things you
              committed to, how you like to be coached, and notes worth
              carrying forward. It reads all of it at the start of every
              conversation.
            </p>
            <p>
              Anything wrong or stale, tap ✕ and it&apos;s gone. Lessons about
              one situation, like fasting, end up in a manual instead.
            </p>
          </InfoButton>
        </h1>
        <button className="btn btn-ghost btn-sm" onClick={up}>
          ‹ Coach
        </button>
      </header>

      {memory === null && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {memory !== null && memory.length === 0 && (
        <div className="empty">
          <div className="empty-icon">🧠</div>
          Nothing yet.
          <div className="faint small" style={{ marginTop: 4 }}>
            As you talk, the coach records goals, commitments and preferences here.
          </div>
        </div>
      )}

      {radar.length > 0 && (
        <>
          <div className="section-title">On its radar</div>
          <div className="list">
            {radar.map((m) => (
              <MemoryRow key={m.id} m={m} today={today} onForget={(id) => void forget(id)} />
            ))}
          </div>
        </>
      )}

      {memory !== null &&
        GROUPS.map((g) => {
          const rows = memory.filter((m) => g.pick(m) && !radarIds.has(m.id));
          if (rows.length === 0) return null;
          return (
            <details key={g.title} className="memory-group" open={g.title !== "Settled commitments"}>
              <summary className="section-title">
                {g.title} <span className="memory-count">{rows.length}</span>
              </summary>
              <div className="list">
                {rows.map((m) => (
                  <MemoryRow key={m.id} m={m} today={today} onForget={(id) => void forget(id)} />
                ))}
              </div>
            </details>
          );
        })}
    </div>
  );
}
