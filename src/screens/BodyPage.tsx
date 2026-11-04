/**
 * The Body tab: what's in you right now, then fasting.
 *
 * Caffeine and alcohol get a curve — where the day's doses have taken you and
 * where they'll take you if nothing else goes in — because the question
 * people bring is about the future: when can I sleep, when is it out of me.
 * Creatine and vitamin D move over weeks, so they get a store instead: how
 * full, and which way it's heading.
 *
 * All of it is read from the diary (lib/body.ts); nothing here is logged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onDiaryChanged } from "../lib/agent";
import { setSetting } from "../lib/db";
import { SETTING_KEYS } from "../lib/types";
import {
  STORE_SHOWN_DAYS,
  loadIntake,
  loadProfile,
  snapshotOf,
} from "../lib/body";
import type { BodyProfile, HourlyLevel, Intake } from "../lib/body";
import {
  CAFFEINE_HALF_LIVES,
  CAFFEINE_SLEEP_MG,
  CREATINE,
  GRAMS_PER_DRINK,
  VITAMIN_D,
  WIDMARK_R,
} from "../lib/bodyModel";
import { shiftDay } from "../lib/daystamp";
import { todayStr } from "../lib/db";
import InfoButton from "../components/InfoButton";
import FastingSection from "./FastingSection";

/** A number that glides to its new value instead of jumping. */
function useGlide(target: number, ms = 700): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = origin + (target - origin) * eased;
      from.current = v;
      setShown(v);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "22:10", or "tomorrow 01:30" when it's past midnight. */
function clockDay(ms: number, now: number): string {
  const day = todayStr(new Date(ms));
  const today = todayStr(new Date(now));
  if (day === today) return clock(ms);
  if (day === shiftDay(today, 1)) return `tomorrow ${clock(ms)}`;
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

const VB_W = 300;
const VB_H = 100;

/**
 * The curve: solid up to now, a fainter dashed forecast after. It draws in
 * from the left on first show, and the now-dot breathes — the level is
 * changing while you look at it.
 */
function LevelCurve({
  level,
  now,
  color,
  threshold,
  thresholdLabel,
  glyph,
  minScale,
}: {
  level: HourlyLevel;
  now: number;
  color: string;
  threshold?: number;
  thresholdLabel?: string;
  glyph: string;
  minScale: number;
}) {
  const { series, from, to, doses } = level;
  const peak = Math.max(minScale, threshold != null ? threshold * 1.6 : 0, ...series.map((p) => p.amount));
  const yMax = peak * 1.12;
  const x = (t: number) => ((t - from) / (to - from)) * VB_W;
  const y = (v: number) => VB_H - (v / yMax) * VB_H;

  const past = series.filter((p) => p.t <= now);
  const future = series.filter((p) => p.t >= now);
  const line = (pts: typeof series) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.amount).toFixed(1)}`).join("");
  const area = (pts: typeof series) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return "";
    return `${line(pts)}L${x(last.t).toFixed(1)},${VB_H}L${x(first.t).toFixed(1)},${VB_H}Z`;
  };
  const nowPoint = past[past.length - 1];
  const nowX = (x(now) / VB_W) * 100;
  const nowY = nowPoint ? (y(nowPoint.amount) / VB_H) * 100 : 100;

  return (
    <div className="level-chart" style={{ ["--level" as string]: color }}>
      <div className="level-plot">
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden>
          {threshold != null && (
            <line
              x1={0}
              x2={VB_W}
              y1={y(threshold)}
              y2={y(threshold)}
              className="level-threshold"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <g className="level-reveal">
            <path d={area(future)} className="level-area-future" />
            <path d={line(future)} className="level-line-future" vectorEffect="non-scaling-stroke" />
            <path d={area(past)} className="level-area" />
            <path d={line(past)} className="level-line" vectorEffect="non-scaling-stroke" />
          </g>
          <line
            x1={x(now)}
            x2={x(now)}
            y1={0}
            y2={VB_H}
            className="level-now-line"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {threshold != null && thresholdLabel && (
          <span
            className="level-threshold-label"
            style={{ top: `calc(${(y(threshold) / VB_H) * 100}% - 15px)` }}
          >
            {thresholdLabel}
          </span>
        )}
        <span className="level-dot" style={{ left: `${nowX}%`, top: `${nowY}%` }} />
        {doses.map((d) => (
          <span
            key={d.at}
            className="level-dose"
            style={{ left: `${(x(d.at) / VB_W) * 100}%` }}
            title={`${clock(d.at)}`}
          >
            {glyph}
          </span>
        ))}
      </div>
      <div className="level-ticks">
        {hourTicks(from, to, now).map((t) => (
          <span key={t} style={{ left: `${(x(t) / VB_W) * 100}%` }}>
            {new Date(t).getHours() === 0 ? "midnight" : clock(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Every six hours on the clock (00, 06, 12, 18) inside the window — a fixed
 * grid reads faster than "8 h ago" — leaving out any that would crowd "now"
 * (the line itself) or the chart's edges.
 */
function hourTicks(from: number, to: number, now: number): number[] {
  const out: number[] = [];
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(Math.ceil(d.getHours() / 6) * 6);
  const margin = (to - from) * 0.06;
  for (let t = d.getTime(); t <= to; t += 6 * 3_600_000) {
    if (t - from < margin || to - t < margin || Math.abs(t - now) < margin) continue;
    out.push(t);
  }
  return out;
}

/** A store that fills over weeks: a tank bar, and its last two months. */
function StoreBar({ fraction, series, color }: { fraction: number; series: number[]; color: string }) {
  // Starts empty and fills to where it is, so the eye reads it as a level.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(fraction));
    return () => cancelAnimationFrame(id);
  }, [fraction]);
  const max = Math.max(1e-9, ...series);
  const pts = series
    .map((v, i) => `${((i / Math.max(1, series.length - 1)) * 100).toFixed(1)},${(30 - (v / max) * 28).toFixed(1)}`)
    .join(" ");
  return (
    <div style={{ ["--level" as string]: color }}>
      <div className="tank">
        <div className="tank-fill" style={{ width: `${Math.min(1, Math.max(0, shown)) * 100}%` }} />
      </div>
      {max > 1e-6 && (
        <svg className="store-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
          <polyline points={pts} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="level-axis">
        <span>{STORE_SHOWN_DAYS} days ago</span>
        <span>today</span>
      </div>
    </div>
  );
}

function HalfLifePicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (h: number) => void;
}) {
  return (
    <div className="seg" style={{ marginTop: 8 }}>
      {CAFFEINE_HALF_LIVES.map((h) => (
        <button
          key={h}
          className={`seg-item${value === h ? " seg-item-active" : ""}`}
          onClick={() => onChange(h)}
        >
          {h} h
        </button>
      ))}
    </div>
  );
}

export default function BodyPage() {
  const [intake, setIntake] = useState<Intake | null>(null);
  const [profile, setProfile] = useState<BodyProfile | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const today = todayStr();
    const [i, p] = await Promise.all([
      loadIntake(shiftDay(today, -120), shiftDay(today, 1)),
      loadProfile(),
    ]);
    setIntake(i);
    setProfile(p);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    return onDiaryChanged(() => void load());
  }, [load]);

  // The levels move by the minute; re-read them from what's already loaded.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const snap = useMemo(
    () => (intake && profile ? snapshotOf(intake, profile, now) : null),
    [intake, profile, now],
  );

  const caffeineMg = useGlide(snap?.caffeine.now ?? 0);
  const alcoholG = useGlide(snap?.alcohol.now ?? 0);

  async function changeHalfLife(h: number) {
    await setSetting(SETTING_KEYS.caffeineHalfLife, String(h));
    setProfile((p) => (p ? { ...p, caffeineHalfLifeH: h } : p));
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Body</h1>
        <span className="page-sub">What&apos;s in you right now</span>
      </header>

      {!snap ? (
        <div className="empty" style={{ display: "flex", justifyContent: "center" }}>
          <span className="spinner" />
        </div>
      ) : (
        <>
          <div className="card level-card">
            <div className="level-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
                ☕ Caffeine
                <InfoButton title="Caffeine">
                  <p>
                    Worked out from the caffeine in what you&apos;ve logged: each
                    dose is absorbed over the best part of an hour, then halves
                    every {snap.profile.caffeineHalfLifeH} hours.
                  </p>
                  <p>
                    People clear it anywhere from 3 to 7 hours — slower on the pill
                    or when pregnant, faster for smokers. If late coffee keeps you
                    up, yours is probably on the long side. Your half-life:
                  </p>
                  <HalfLifePicker
                    value={snap.profile.caffeineHalfLifeH}
                    onChange={(h) => void changeHalfLife(h)}
                  />
                  <p>
                    The line at {CAFFEINE_SLEEP_MG} mg is roughly where caffeine
                    stops measurably costing deep sleep. Ask the coach to compare
                    caffeine at bedtime with your sleep.
                  </p>
                </InfoButton>
              </div>
              <div className="level-value">
                {Math.round(caffeineMg)}
                <span className="level-unit"> mg</span>
              </div>
            </div>
            <div className="muted small level-caption">
              {snap.caffeine.now < 1 && snap.caffeine.doses.length === 0
                ? "None in your body."
                : snap.caffeine.belowSleepAt == null
                  ? `Above ${CAFFEINE_SLEEP_MG} mg for the next two days.`
                  : snap.caffeine.belowSleepAt <= now
                    ? `Under ${CAFFEINE_SLEEP_MG} mg — clear for sleep.`
                    : `Under ${CAFFEINE_SLEEP_MG} mg at ${clockDay(snap.caffeine.belowSleepAt, now)}.`}
            </div>
            <LevelCurve
              level={snap.caffeine}
              now={now}
              color="var(--caffeine)"
              threshold={CAFFEINE_SLEEP_MG}
              thresholdLabel={`sleep · ${CAFFEINE_SLEEP_MG} mg`}
              glyph="☕"
              minScale={60}
            />
          </div>

          <div className="card level-card">
            <div className="level-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
                🍷 Alcohol
                <InfoButton title="Alcohol">
                  <p>
                    Worked out from the alcohol in what you&apos;ve logged. Unlike
                    caffeine it clears at a steady rate — about{" "}
                    {Math.round(snap.profile.weightKg * 0.11)} g an hour at{" "}
                    {Math.round(snap.profile.weightKg)} kg
                    {snap.profile.weightKnown ? "" : " (assumed — no weight synced)"} —
                    however much is in you, which is why the fifth drink takes as
                    long to clear as the first.
                  </p>
                  <p>
                    One drink (genstand) is {GRAMS_PER_DRINK} g. The ‰ is a rough
                    Widmark estimate (r = {WIDMARK_R}); real values vary by ±30% with
                    sex, food and body. Never use it to decide whether you can drive.
                  </p>
                </InfoButton>
              </div>
              <div className="level-value">
                {(alcoholG / GRAMS_PER_DRINK).toFixed(1)}
                <span className="level-unit"> drinks</span>
              </div>
            </div>
            <div className="muted small level-caption">
              {snap.alcohol.now < 0.1 && snap.alcohol.doses.length === 0
                ? "None in your body."
                : snap.alcohol.now < 0.1
                  ? "Cleared."
                  : `${Math.round(snap.alcohol.now)} g · ~${snap.alcohol.promille.toFixed(2)} ‰ · cleared ${
                      snap.alcohol.goneAt == null ? "in over two days" : `at ${clockDay(snap.alcohol.goneAt, now)}`
                    }`}
            </div>
            {(snap.alcohol.doses.length > 0 || snap.alcohol.now >= 0.1) && (
              <LevelCurve
                level={snap.alcohol}
                now={now}
                color="var(--alcohol)"
                glyph="🍷"
                minScale={GRAMS_PER_DRINK}
              />
            )}
          </div>
        </>
      )}

      {snap && (
        <>
          <div className="section-title">Stores</div>
          <div className="card level-card">
            <div className="level-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
                💪 Creatine
                <InfoButton title="Creatine">
                  <p>
                    Creatine works by filling up the store in your muscles, which
                    takes weeks — so this shows how full that store is, not what
                    you took today. Only creatine taken as a supplement counts; meat
                    keeps the baseline you start from.
                  </p>
                  <p>
                    Roughly: 3–5 g a day fills it in about four weeks, a 20 g
                    loading week in five or six days. Stop, and it drains back over
                    four to six weeks (half in about {CREATINE.halfLifeDays} days).
                    An average model — nobody&apos;s store is measured without a
                    biopsy.
                  </p>
                </InfoButton>
              </div>
              <div className="level-value">
                {Math.round(snap.creatine.fraction * 100)}
                <span className="level-unit">% full</span>
              </div>
            </div>
            <div className="muted small level-caption">
              {snap.creatine.lastDay == null
                ? "No creatine logged in the last four months."
                : snap.creatine.avg7 < 0.1
                  ? `Draining — last taken ${snap.creatine.lastDay}.`
                  : snap.creatine.daysToFull === 0
                    ? `Topped up · ${snap.creatine.avg7.toFixed(1)} g/day this week keeps it there.`
                    : snap.creatine.daysToFull == null
                      ? `${snap.creatine.avg7.toFixed(1)} g/day this week won't fill it — 3–5 g daily does.`
                      : `${snap.creatine.avg7.toFixed(1)} g/day this week · full in ~${snap.creatine.daysToFull} days.`}
            </div>
            <StoreBar
              fraction={snap.creatine.fraction}
              series={snap.creatine.series}
              color="var(--accent)"
            />
          </div>

          <div className="card level-card">
            <div className="level-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
                ☀️ Vitamin D
                <InfoButton title="Vitamin D">
                  <p>
                    How much the vitamin D you&apos;ve logged — food and supplements
                    — adds to your blood level (25(OH)D, what a blood test
                    measures). It builds and fades slowly: half of it is gone{" "}
                    {VITAMIN_D.halfLifeDays} days after you stop.
                  </p>
                  <p>
                    This is only the logged part. Sun and where you started add to
                    it, and the diary can&apos;t see either — a blood test is the real
                    number. As a guide, 50–75 nmol/L or more is usually considered
                    enough, and each µg a day adds about{" "}
                    {VITAMIN_D.nmolPerUgDaily} nmol/L once it settles.
                  </p>
                </InfoButton>
              </div>
              <div className="level-value">
                +{Math.round(snap.vitaminD.contribution)}
                <span className="level-unit"> nmol/L</span>
              </div>
            </div>
            <div className="muted small level-caption">
              {snap.vitaminD.avg30 < 0.1
                ? "No vitamin D logged in the last month."
                : `${snap.vitaminD.avg30.toFixed(1)} µg/day this month · settles around +${Math.round(snap.vitaminD.steady)} nmol/L.`}
            </div>
            <StoreBar
              fraction={Math.min(1, snap.vitaminD.contribution / 75)}
              series={snap.vitaminD.series}
              color="var(--vitd)"
            />
          </div>
        </>
      )}

      <FastingSection />
    </div>
  );
}
