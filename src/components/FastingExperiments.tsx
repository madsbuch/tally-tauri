/**
 * Running fasting experiments, where the fast is.
 *
 * During a fast: which option the refeed is, so the plan is in front of you
 * at the moment you break it, not in a page you'd have to remember to open.
 * After one: the trial it opened, waiting for your ratings — right where
 * you just were, for a couple of days, then it waits on the experiment page.
 */
import { useEffect, useState } from "react";
import { listRunningExperimentsFor, listTrials } from "../lib/db";
import type { Experiment, ExperimentTrial } from "../lib/types";
import {
  EXPERIMENT_GLYPH,
  RATE_AFTER_H,
  armName,
  experimentPath,
  isReadyToConclude,
  isUnrated,
  nextArm,
  onExperimentsChanged,
} from "../lib/experiments";
import { useGo } from "../lib/navigation";
import TrialCard from "./TrialCard";

/** How long after a refeed its rating is asked for here. */
const ASK_FOR_MS = 48 * 3_600_000;

interface Row {
  e: Experiment;
  trials: ExperimentTrial[];
}

export default function FastingExperiments({ fasting }: { fasting: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [refresh, setRefresh] = useState(0);
  const go = useGo();

  useEffect(() => onExperimentsChanged(() => setRefresh((n) => n + 1)), []);

  useEffect(() => {
    let alive = true;
    listRunningExperimentsFor("fasting")
      .then((all) => Promise.all(all.map(async (e) => ({ e, trials: await listTrials(e.id) }))))
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
    // A fast ending opens trials, so look again when it flips.
  }, [refresh, fasting]);

  if (rows.length === 0) return null;

  if (fasting) {
    return (
      <>
        {rows.map(({ e, trials }) => {
          const ready = isReadyToConclude(e, trials);
          const next = nextArm(e, trials);
          return (
            <button key={e.id} className="manual-link" onClick={() => go(experimentPath(e.id))}>
              <span>{EXPERIMENT_GLYPH}</span>
              <span style={{ flex: 1 }}>
                {ready
                  ? `${e.title}: every option has its trials`
                  : e.assignment === "balanced"
                    ? `Refeed: ${armName(next)}`
                    : `Refeed: your pick — ${e.arms.map((a) => a.key).join(" / ")}`}
                <span className="muted small" style={{ display: "block" }}>
                  {ready
                    ? "This fast still counts; ask the coach to conclude it."
                    : e.assignment === "balanced"
                      ? next.detail || e.title
                      : e.title}
                </span>
              </span>
              <span className="faint">›</span>
            </button>
          );
        })}
      </>
    );
  }

  const now = Date.now();
  const pending = rows.flatMap(({ e, trials }) =>
    trials
      .filter((t) => isUnrated(e, t) && now - new Date(t.started_at).getTime() < ASK_FOR_MS)
      .map((t) => ({ e, t })),
  );
  if (pending.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-title">{EXPERIMENT_GLYPH} How did the refeed go?</div>
      {pending.map(({ e, t }) => {
        const early = now - new Date(t.started_at).getTime() < RATE_AFTER_H * 3_600_000;
        return (
          <div key={t.id} style={{ marginBottom: 10 }}>
            <button
              className="chat-suggestion"
              style={{ background: "none", border: "none", padding: 0, textAlign: "left" }}
              onClick={() => go(experimentPath(e.id))}
            >
              <span className="row-title">{e.title} ›</span>
            </button>
            {early && (
              <div className="muted small">
                Best rated an hour or two after eating — but now is fine too.
              </div>
            )}
            <TrialCard experiment={e} trial={t} compact />
          </div>
        );
      })}
    </div>
  );
}
