/**
 * One experiment: the options, how each is doing, and every trial.
 *
 * Read top-down it answers the questions in the order you have them: what is
 * this testing, what do I do next time, what does it show so far — and only
 * then the trials themselves, where ratings are given and a trial that
 * shouldn't count is set aside.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getExperiment, getManual, listAllFasts, listTrials } from "../lib/db";
import type { Experiment, ExperimentTrial, Fast, Manual } from "../lib/types";
import type { ArmSummary, TrialMetrics } from "../lib/experiments";
import {
  AUTO_METRIC_INFO,
  EXPERIMENT_GLYPH,
  armCounts,
  autoMetricsOf,
  isReadyToConclude,
  loadTrialMetrics,
  nextArm,
  onExperimentsChanged,
  parseExperimentId,
  ratingMeasures,
  removeExperiment,
  saveExperiment,
  startTrial,
  summarize,
} from "../lib/experiments";
import { onManualsChanged, manualPath } from "../lib/manuals";
import { chatPath, useGo } from "../lib/navigation";
import { startAssistantChat } from "../lib/assistantRunner";
import TrialCard, { formatMetric } from "../components/TrialCard";
import type { AutoMetric } from "../lib/schemas";

interface Loaded {
  e: Experiment;
  trials: ExperimentTrial[];
  metrics: Map<number, TrialMetrics>;
  manual: Manual | null;
}

function Options({ e, trials }: { e: Experiment; trials: ExperimentTrial[] }) {
  const counts = armCounts(e, trials);
  const running = e.status === "running";
  const next = running && e.assignment === "balanced" && !isReadyToConclude(e, trials)
    ? nextArm(e, trials).key
    : null;
  return (
    <div className="card">
      <h2 className="card-title">Options</h2>
      <div className="exp-arms">
        {e.arms.map((a) => {
          const n = counts.get(a.key) ?? 0;
          return (
            <div key={a.key} className={`exp-arm${next === a.key ? " exp-arm-next" : ""}`}>
              <span className="exp-arm-key">{a.key}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row-title" style={{ whiteSpace: "normal" }}>
                  {a.label}
                </div>
                {a.detail && <div className="muted small">{a.detail}</div>}
                <div className="exp-progress">
                  <span style={{ width: `${Math.min(100, (n / e.target_per_arm) * 100)}%` }} />
                </div>
                <div className="faint small" style={{ marginTop: 2 }}>
                  {n} of {e.target_per_arm} trials
                  {next === a.key && <span className="exp-next"> · next up</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {running && e.assignment === "choose" && (
        <p className="muted small" style={{ margin: "10px 0 0" }}>
          You pick the option each time; mark which one on the trial.
        </p>
      )}
    </div>
  );
}

function Results({
  e,
  summary,
}: {
  e: Experiment;
  summary: ArmSummary[];
}) {
  const rows: { key: string; label: string; better: "higher" | "lower"; auto: AutoMetric | null }[] = [
    ...ratingMeasures(e).map((m) => ({ key: m.key, label: m.label, better: m.better, auto: null })),
    ...autoMetricsOf(e).map((k) => ({
      key: k,
      label: AUTO_METRIC_INFO[k].label,
      better: AUTO_METRIC_INFO[k].better,
      auto: k,
    })),
  ];
  if (rows.length === 0 || summary.every((s) => s.n === 0)) return null;
  const minN = Math.min(...summary.map((s) => s.n));
  return (
    <div className="card">
      <h2 className="card-title">So far</h2>
      <div className="exp-table-wrap">
        <table className="exp-table">
          <thead>
            <tr>
              <th />
              {summary.map((s) => (
                <th key={s.arm.key}>
                  {s.arm.key} <span className="faint">({s.n})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const vals = summary.map((s) => s.means.get(r.key)?.mean);
              const present = vals.filter((v): v is number => v != null);
              // Only mark a leader when every option has a number to compare.
              const best =
                present.length === summary.length && present.length > 1
                  ? r.better === "higher"
                    ? Math.max(...present)
                    : Math.min(...present)
                  : null;
              // fast_h is context, not an outcome: no winner.
              const judge = r.key !== "fast_h";
              return (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  {vals.map((v, i) => (
                    <td
                      key={summary[i]?.arm.key ?? i}
                      className={judge && v != null && v === best ? "exp-best" : ""}
                    >
                      {v == null ? "–" : r.auto ? formatMetric(r.auto, v) : v.toFixed(1)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="faint small" style={{ margin: "8px 0 0" }}>
        Averages over the trials that count.
        {minN < 3 ? " With this few, a difference can easily be one good or bad day." : ""}
      </p>
    </div>
  );
}

export default function ExperimentPage() {
  const id = parseExperimentId(useParams()["experimentId"]);
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined);
  const data = id === null ? null : loaded;
  const [refresh, setRefresh] = useState(0);
  const go = useGo();

  useEffect(() => {
    let alive = true;
    if (id === null) return;
    void (async () => {
      const e = await getExperiment(id);
      if (!e) return null;
      const [trials, fasts, manual] = await Promise.all([
        listTrials(id),
        listAllFasts().catch(() => [] as Fast[]),
        e.manual_id != null ? getManual(e.manual_id).catch(() => null) : Promise.resolve(null),
      ]);
      const metrics = await loadTrialMetrics(trials, new Map(fasts.map((f) => [f.id, f])));
      return { e, trials, metrics, manual };
    })()
      .then((d) => {
        if (alive) setLoaded(d);
      })
      .catch(() => {
        if (alive) setLoaded(null);
      });
    return () => {
      alive = false;
    };
  }, [id, refresh]);

  useEffect(() => {
    const bump = () => setRefresh((n) => n + 1);
    const off1 = onExperimentsChanged(bump);
    const off2 = onManualsChanged(bump);
    return () => {
      off1();
      off2();
    };
  }, []);

  function ask(text: string) {
    void startAssistantChat(text).then((chat) => {
      if (chat !== null) go(chatPath(chat));
    });
  }

  async function setStatus(status: Experiment["status"]) {
    if (!data) return;
    if (status === "dropped" && !window.confirm(`Stop “${data.e.title}” without a conclusion?`)) return;
    await saveExperiment(data.e.id, { status });
  }

  async function remove() {
    if (!data) return;
    if (!window.confirm(`Delete “${data.e.title}” and all its trials?`)) return;
    await removeExperiment(data.e.id);
    go("/assistant/experiments");
  }

  async function logTrial() {
    if (!data) return;
    await startTrial(data.e, nextArm(data.e, data.trials).key, new Date().toISOString());
  }

  const e = data?.e;
  const trials = data?.trials ?? [];
  const running = e?.status === "running";

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{e?.title ?? "Experiment"}</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => go("/assistant/experiments")}>
          ‹ Experiments
        </button>
      </header>

      {data === undefined && (
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <span className="spinner" />
        </div>
      )}

      {data === null && (
        <div className="empty">
          <div className="empty-icon">{EXPERIMENT_GLYPH}</div>
          This experiment is gone.
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-sm" onClick={() => go("/assistant/experiments")}>
              All experiments
            </button>
          </div>
        </div>
      )}

      {data && e && (
        <>
          <p className="muted small" style={{ margin: "0 2px 6px" }}>
            {e.hypothesis}
          </p>
          <div className="chips" style={{ margin: "0 0 12px" }}>
            <span className={`chip${running ? " chip-accent" : ""}`}>
              {running ? "Running" : e.status === "concluded" ? "Concluded" : "Dropped"}
            </span>
            <span className="chip">
              {e.applies_when === "fasting" ? "Every fast is a trial" : "Trials logged by hand"}
            </span>
            <span className="chip">
              {e.assignment === "balanced" ? "Option picked for you" : "You pick the option"}
            </span>
          </div>

          {!running && (e.conclusion || data.manual) && (
            <div className="card">
              <h2 className="card-title">What it showed</h2>
              {e.conclusion && (
                <p style={{ margin: 0, lineHeight: 1.5 }}>{e.conclusion}</p>
              )}
              {data.manual && (
                <button className="manual-link" onClick={() => go(manualPath(data.manual!.id))}>
                  <span>📖</span>
                  <span style={{ flex: 1 }}>Written into “{data.manual.title}”</span>
                  <span className="faint">›</span>
                </button>
              )}
            </div>
          )}

          <Options e={e} trials={trials} />
          <Results e={e} summary={summarize(e, trials, data.metrics)} />

          {running && isReadyToConclude(e, trials) && (
            <div className="card">
              <h2 className="card-title">Ready to conclude</h2>
              <p className="muted small" style={{ margin: "0 0 10px" }}>
                Every option has its trials. The coach can read the numbers,
                say what they show, and carry it into your manual.
              </p>
              <button
                className="btn btn-primary"
                style={{ width: "100%" }}
                onClick={() =>
                  ask(`Read my experiment "${e.title}" [${e.id}] and conclude it: what did it show, and should it go in a manual?`)
                }
              >
                Conclude with the coach
              </button>
            </div>
          )}

          <div className="input-row" style={{ marginBottom: 12 }}>
            {running && (
              <button
                className="btn"
                onClick={() =>
                  ask(`How is my experiment "${e.title}" [${e.id}] looking so far?`)
                }
              >
                Ask the coach
              </button>
            )}
            {running && e.applies_when !== "fasting" && (
              <button className="btn" onClick={() => void logTrial()}>
                Log a trial now
              </button>
            )}
          </div>

          <div className="section-title">Trials</div>
          {trials.length === 0 && (
            <div className="muted small" style={{ margin: "0 2px 12px" }}>
              {e.applies_when === "fasting"
                ? "None yet. The next fast you finish becomes the first trial."
                : "None yet."}
            </div>
          )}
          {[...trials].reverse().map((t) => (
            <TrialCard key={t.id} experiment={e} trial={t} metrics={data.metrics.get(t.id)} />
          ))}

          <div className="input-row" style={{ marginTop: 6 }}>
            {running ? (
              <button className="btn" onClick={() => void setStatus("dropped")}>
                Stop it
              </button>
            ) : (
              <button className="btn" onClick={() => void setStatus("running")}>
                Run it again
              </button>
            )}
            <button className="btn btn-danger" onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
