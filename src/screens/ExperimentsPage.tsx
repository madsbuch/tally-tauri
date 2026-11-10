/**
 * The experiments: what's being tested, and what earlier tests showed.
 *
 * Like the manuals there's no "new" button — an experiment is designed with
 * the coach, who makes sure it compares concrete options and decides what
 * counts as better before the first trial. The empty state hands that
 * conversation over.
 */
import { useEffect, useState } from "react";
import { listExperiments, listTrials } from "../lib/db";
import type { Experiment, ExperimentTrial } from "../lib/types";
import {
  EXPERIMENT_GLYPH,
  armCounts,
  armName,
  experimentPath,
  isReadyToConclude,
  needsRating,
  nextArm,
  onExperimentsChanged,
} from "../lib/experiments";
import InfoButton from "../components/InfoButton";
import { chatPath, useGo, useUp } from "../lib/navigation";
import { startAssistantChat } from "../lib/assistantRunner";

const STARTER =
  "I'd like to set up an experiment. Help me turn what I want to test into options to compare and what to measure.";

interface Row {
  e: Experiment;
  trials: ExperimentTrial[];
}

const STATUS_LABEL: Record<Experiment["status"], string> = {
  running: "Running",
  concluded: "Concluded",
  dropped: "Dropped",
};

export default function ExperimentsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const up = useUp();
  const go = useGo();

  useEffect(() => {
    let alive = true;
    listExperiments()
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
  }, [refresh]);

  useEffect(() => onExperimentsChanged(() => setRefresh((n) => n + 1)), []);

  function askCoach() {
    void startAssistantChat(STARTER).then((id) => {
      if (id !== null) go(chatPath(id));
    });
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Experiments
          <InfoButton title="Experiments">
            <p>
              A fair test of something you think works for you, before it goes
              in a manual. An experiment compares a few concrete options, and
              decides up front what counts as better: ratings you give
              afterwards, and numbers the diary already has.
            </p>
            <p>
              A fasting experiment makes every fast you finish a trial. The app
              picks the option for the refeed, so the options alternate, and
              asks for your ratings on the Diary&apos;s fasting card afterwards.
            </p>
            <p>
              When every option has its trials, the coach writes up what it
              showed, and puts it in the manual if it held.
            </p>
          </InfoButton>
        </h1>
        <button className="btn btn-ghost btn-sm" onClick={up}>
          ‹ Coach
        </button>
      </header>

      {rows === null && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {rows !== null && rows.length === 0 && (
        <div className="empty">
          <div className="empty-icon">{EXPERIMENT_GLYPH}</div>
          No experiments yet.
          <div className="faint small" style={{ marginTop: 4 }}>
            Tell the coach what you want to find out, e.g. &ldquo;Does breaking
            a fast with carbs first make re-entry easier?&rdquo;
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-sm btn-primary" onClick={askCoach}>
              Design one with the coach
            </button>
          </div>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="list">
          {rows.map(({ e, trials }) => {
            const counts = armCounts(e, trials);
            const done = [...counts.values()].reduce((a, n) => a + Math.min(n, e.target_per_arm), 0);
            const total = e.arms.length * e.target_per_arm;
            const toRate = trials.filter((t) => needsRating(e, t)).length;
            return (
              <button
                key={e.id}
                className="list-row chat-suggestion"
                style={{ width: "100%", textAlign: "left" }}
                onClick={() => go(experimentPath(e.id))}
              >
                <div className="row-main">
                  <div className="row-title">{e.title}</div>
                  <div className="row-sub" style={{ whiteSpace: "normal" }}>
                    {e.status === "running" ? e.hypothesis : (e.conclusion ?? e.hypothesis)}
                  </div>
                  <div className="chips" style={{ marginTop: 6 }}>
                    <span className={`chip${e.status === "running" ? " chip-accent" : ""}`}>
                      {STATUS_LABEL[e.status]}
                    </span>
                    {e.status === "running" && (
                      <span className="chip">
                        {done}/{total} trials
                      </span>
                    )}
                    {e.status === "running" && toRate > 0 && (
                      <span className="chip chip-warn">{toRate} to rate</span>
                    )}
                    {e.status === "running" && isReadyToConclude(e, trials) && (
                      <span className="chip chip-accent">Ready to conclude</span>
                    )}
                    {e.status === "running" &&
                      e.assignment === "balanced" &&
                      !isReadyToConclude(e, trials) && (
                        <span className="chip">Next: {armName(nextArm(e, trials))}</span>
                      )}
                  </div>
                </div>
                <div className="row-end">›</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
