/**
 * The Body tab's newer stores: beta-alanine, the omega-3 index, ferritin and
 * the vitamin reserves next to creatine and vitamin D; then glycogen, training
 * load and sleep debt, each in its own section. The numbers come from
 * lib/body.ts; the models and their sources are in lib/storeModels.ts.
 */
import type { ReactNode } from "react";
import type { BodySnapshot } from "../lib/body";
import {
  BETA_ALANINE,
  BETA_ALANINE_WORKING,
  FERRITIN,
  FERRITIN_BANDS,
  GLYCOGEN,
  LIVER_KETOSIS,
  OMEGA3,
  OMEGA3_BANDS,
  OMEGA3_TARGET,
  RESERVE_CAP,
  SLEEP,
  SLEEP_BANDS,
  TRAINING,
  LOAD_FOCUS,
} from "../lib/storeModels";
import { formatAmount } from "../lib/nutrients";
import { useGo } from "../lib/navigation";
import InfoButton from "../components/InfoButton";
import {
  BandGauge,
  LevelCurve,
  MultiSpark,
  SegPicker,
  StoreBar,
  TONE_COLOR,
  clock,
  clockDay,
  dayLabel,
} from "../components/BodyCharts";
import { SLEEP_SHOWN_NIGHTS } from "../lib/body";

type Snap = BodySnapshot;

function Head({
  title,
  info,
  value,
  unit,
}: {
  title: string;
  info: ReactNode;
  value: ReactNode;
  unit: string;
}) {
  return (
    <div className="level-head">
      <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {title}
        <InfoButton title={title.replace(/^\S+\s/, "")}>{info}</InfoButton>
      </div>
      <div className="level-value">
        {value}
        <span className="level-unit">{unit}</span>
      </div>
    </div>
  );
}

function Status({ label, tone, extra }: { label: string; tone: keyof typeof TONE_COLOR; extra?: string }) {
  return (
    <div className="store-status" style={{ color: TONE_COLOR[tone] }}>
      {label}
      {extra && <span className="muted"> · {extra}</span>}
    </div>
  );
}

/** "Add a blood test →": the way to pin a lab-anchored store. */
function LabLink() {
  const go = useGo();
  return (
    <button type="button" className="btn btn-ghost store-link" onClick={() => go("/assistant/library")}>
      Add a blood test →
    </button>
  );
}

/** A labelled bar without history, for glycogen's muscle store. */
function MiniTank({ label, fraction, color }: { label: string; fraction: number; color: string }) {
  return (
    <div className="mini-tank" style={{ ["--level" as string]: color }}>
      <span className="mini-tank-label">{label}</span>
      <div className="tank">
        <div className="tank-fill" style={{ width: `${Math.min(1, Math.max(0, fraction)) * 100}%` }} />
      </div>
      <span className="mini-tank-value">{Math.round(fraction * 100)}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export function BetaAlanineCard({ snap }: { snap: Snap }) {
  const b = snap.betaAlanine;
  const working = Math.round(BETA_ALANINE_WORKING * BETA_ALANINE.maxRisePct);
  return (
    <div className="card level-card">
      <Head
        title="⚡ Beta-alanine"
        value={Math.round(b.fraction * 100)}
        unit="% loaded"
        info={
          <>
            <p>
              Beta-alanine builds up carnosine in your muscles — the buffer
              behind the burn in hard efforts of one to four minutes. Like
              creatine it works by filling a store, not by the day&apos;s dose.
            </p>
            <p>
              4–6 g a day (split, to avoid the tingle) raises carnosine about
              40–60% in four weeks and up to ~{BETA_ALANINE.maxRisePct}% by ten.
              Stop and it drifts back over three to four months. 100% here is
              the most it can rise; the line marks +{working}%, roughly where
              studies see the benefit. Logged as beta_alanine_g on a supplement
              or pre-workout.
            </p>
          </>
        }
      />
      <div className="muted small level-caption">
        {b.lastDay == null
          ? "No beta-alanine logged in the last four months."
          : `About +${Math.round(b.fraction * BETA_ALANINE.maxRisePct)}% carnosine · ${b.avg7.toFixed(1)} g/day this week.`}
      </div>
      <StoreBar
        fraction={b.fraction}
        series={b.series}
        color="var(--accent)"
        threshold={BETA_ALANINE_WORKING}
        thresholdLabel={`+${working}%`}
        scaleMax={1}
      />
    </div>
  );
}

export function Omega3Card({ snap }: { snap: Snap }) {
  const o = snap.omega3;
  const advice =
    o.index >= OMEGA3_TARGET
      ? `On target. ${o.avg30.toFixed(2)} g EPA + DHA a day keeps it around ${o.settles.toFixed(1)}%.`
      : o.avg30 < 0.05
        ? `No fish or fish oil logged lately. About ${o.gramsForTarget.toFixed(1)} g EPA + DHA a day would reach ${OMEGA3_TARGET}%.`
        : `${o.avg30.toFixed(2)} g EPA + DHA a day settles around ${o.settles.toFixed(1)}%. About ${o.gramsForTarget.toFixed(1)} g a day reaches ${OMEGA3_TARGET}%.`;
  return (
    <div className="card level-card">
      <Head
        title="🐟 Omega-3 index"
        value={`${o.test ? "" : "~"}${o.index.toFixed(1)}`}
        unit="%"
        info={
          <>
            <p>
              The share of EPA and DHA — the marine omega-3s — in your red
              blood cells. Under 4% is linked to higher heart risk, 8% and over
              is the usual target. Red cells live about four months, so it moves
              slowly.
            </p>
            <p>
              Without fish or fish oil most people sit around{" "}
              {OMEGA3.baselinePct}%; each gram a day of EPA + DHA settles it
              about {OMEGA3.pctPerGDaily} points higher. Plant omega-3 (flax,
              chia, walnuts) is ALA and barely counts. A portion of salmon has
              roughly 1.5–2 g; a standard fish-oil capsule 0.3 g.
            </p>
            <p>
              An omega-3 index test (a finger-prick kit) photographed into the
              Library pins it.
              {o.test &&
                ` Using your test from ${dayLabel(o.test.day)}: ${o.test.value.toFixed(1)}%.`}
            </p>
          </>
        }
      />
      <Status label={o.band.label} tone={o.band.tone} />
      <div className="muted small level-caption">
        {advice} {o.test ? `From your test on ${dayLabel(o.test.day)}.` : "An estimate — a test pins it."}
      </div>
      <BandGauge
        value={o.index}
        scaleMax={OMEGA3.scaleMax}
        bands={OMEGA3_BANDS}
        ticks={[4, OMEGA3_TARGET]}
        lines={[OMEGA3_TARGET]}
        series={o.series}
        band={o.band}
        format={(n) => `${n}%`}
      />
      {!o.test && <LabLink />}
    </div>
  );
}

export function FerritinCard({ snap }: { snap: Snap }) {
  const f = snap.ferritin;
  const rising = f.avg30 > 0 && f.settles > f.level + 5;
  const advice =
    f.level < 50 && rising
      ? `${f.level < 30 ? "Low" : "Borderline"}, but rising: ${f.avg30.toFixed(1)} mg iron a day settles around ${Math.round(f.settles)} µg/L.`
      : f.level < 30
      ? `Low. About ${f.ironForGood.toFixed(0)} mg iron a day would bring it toward 50 — but low ferritin has other causes too, worth a word with a doctor.`
      : f.level < 50
        ? `Borderline. About ${f.ironForGood.toFixed(0)} mg iron a day settles it around 50.`
        : f.avg30 > 0
          ? `${f.avg30.toFixed(1)} mg iron a day settles around ${Math.round(f.settles)} µg/L.`
          : "No iron logged lately.";
  return (
    <div className="card level-card">
      <Head
        title="🩸 Ferritin"
        value={`${f.test ? "" : "~"}${Math.round(f.level)}`}
        unit=" µg/L"
        info={
          <>
            <p>
              Ferritin is how a blood test sees your stored iron — each µg/L is
              roughly {FERRITIN.mgPerUgL} mg in store. Under 30 is depleted,
              30–50 borderline (many feel it, especially athletes), 50–200 good.
            </p>
            <p>
              The body absorbs more iron when the store is low and less when
              it&apos;s full, so here absorption slides from ~17% to ~7%. The
              store loses about {FERRITIN.lossMgPerDay} mg a day — more with
              periods or blood donation, which the app doesn&apos;t know. Iron
              from meat absorbs better than from plants, and tea or coffee with
              a meal cuts it.
            </p>
            <p>
              The least certain card: not every logged food has its iron
              estimated. A ferritin result in the Library pins it, and from then
              on it&apos;s only the drift since that test.
              {f.test && ` Using your test from ${dayLabel(f.test.day)}: ${Math.round(f.test.value)} µg/L.`}
            </p>
          </>
        }
      />
      <Status label={f.band.label} tone={f.band.tone} />
      <div className="muted small level-caption">
        {advice} {f.test ? `From your test on ${dayLabel(f.test.day)}.` : "An estimate — a test pins it."}
      </div>
      <BandGauge
        value={f.level}
        scaleMax={FERRITIN.scaleMax}
        bands={FERRITIN_BANDS}
        ticks={[30, 50, 200]}
        lines={[30, 50]}
        series={f.series}
        band={f.band}
      />
      {!f.test && <LabLink />}
    </div>
  );
}

export function ReservesCard({ snap }: { snap: Snap }) {
  return (
    <div className="card level-card">
      <Head
        title="🧺 Reserves"
        value=""
        unit=""
        info={
          <>
            <p>
              Vitamins and minerals the body keeps a stock of. 100% is the
              store you&apos;d have from meeting the daily reference intake every
              day; the mark on each bar is that line. Days with nothing logged
              are skipped, not counted as zero.
            </p>
            {snap.reserves.map((r) => (
              <p key={r.def.key}>
                <b>{r.def.label}</b> — kept in {r.def.where}. Reference{" "}
                {formatAmount(r.def.key, r.def.ref)} a day.
              </p>
            ))}
            <p>
              A rough guide only: many foods have no estimate for these, which
              makes the bars read low.
            </p>
          </>
        }
      />
      <div className="reserve-rows">
        {snap.reserves.map((r) => (
          <div key={r.def.key} className="reserve-row" style={{ ["--level" as string]: TONE_COLOR[r.band.tone] }}>
            <span className="reserve-label">
              {r.def.glyph} {r.def.label}
            </span>
            <div className="tank-wrap reserve-tank">
              <div className="tank">
                <div className="tank-fill" style={{ width: `${(Math.min(RESERVE_CAP, r.fraction) / RESERVE_CAP) * 100}%` }} />
              </div>
              <span className="tank-mark" style={{ left: `${(1 / RESERVE_CAP) * 100}%` }} />
            </div>
            <span className="reserve-value">{Math.round(Math.min(RESERVE_CAP, r.fraction) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------------

export function GlycogenCard({ snap }: { snap: Snap }) {
  const g = snap.glycogen;
  const now = snap.at;
  const pct = Math.round(LIVER_KETOSIS * 100);
  let caption: string;
  if (!g.hasData) caption = "No carbs or workouts logged in the last few days.";
  else if (g.ketosisAt != null && g.ketosisAt <= now)
    caption = `Liver under ${pct}% — the body is leaning on fat, and ketones are likely up.`;
  else if (g.ketosisAt != null)
    caption = `With no more carbs, the liver drops under ${pct}% (ketones rising) around ${clockDay(g.ketosisAt, now)}.`;
  else caption = "Plenty in the liver for the next day.";
  const k = g.lastKetone;
  const ketoneNote = k ? ` Pinned by your ketone reading of ${k.value.toFixed(1)} mmol/L at ${clockDay(k.at, now)}.` : "";
  return (
    <div className="card level-card">
      <Head
        title="🍞 Glycogen"
        value={Math.round(g.liver * 100)}
        unit="% liver"
        info={
          <>
            <p>
              Carbohydrate stored as glycogen: about {GLYCOGEN.liverCapG} g in the
              liver, which keeps your blood sugar up between meals, and about{" "}
              {GLYCOGEN.musclePerKg} g per kg of body weight in muscle, which only
              that muscle can use.
            </p>
            <p>
              Net carbs you log refill it; your brain draws on the liver between
              meals (an overnight fast leaves it about half full, a day-long one
              nearly empty), and workouts burn mostly muscle glycogen — more at
              high intensity than in zone 2. Under {pct}% liver, the body leans on
              fat and ketones climb: that&apos;s the line on the chart.
            </p>
            <p>
              Your ketone meter readings pin it: 0.5 mmol/L or more means the
              liver is low, under 0.3 that it isn&apos;t. 🍞 marks carbs, 🧪 your
              readings. The curve ahead assumes you eat nothing more.
            </p>
          </>
        }
      />
      <div className="muted small level-caption">
        {caption}
        {ketoneNote}
      </div>
      <LevelCurve
        level={g.curve}
        now={now}
        color="var(--vitd)"
        threshold={pct}
        thresholdLabel="ketosis"
        glyph="🍞"
        minScale={100}
        marks={
          k && k.at >= g.curve.from
            ? [{ at: k.at, glyph: "🧪", title: `${k.value.toFixed(1)} mmol/L at ${clock(k.at)}` }]
            : []
        }
      />
      <MiniTank label="Muscle" fraction={g.muscle} color="var(--accent)" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/** "MAINTAINING" → "Maintaining", "NO_STATUS" → "No status". */
function garminWord(v: string): string {
  const t = v.replace(/_/g, " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function TrainingCard({ snap }: { snap: Snap }) {
  const t = snap.training;
  const g = t.garmin;
  const fromGarmin = t.ratioFrom === "garmin" && g?.acute != null && g.chronic != null;
  const acute = fromGarmin ? (g?.acute ?? 0) : t.fatigue * TRAINING.weekly;
  const chronic = fromGarmin ? (g?.chronic ?? 0) : t.fitness * TRAINING.weekly;
  const uncounted = t.workouts28 - t.garminCounted;
  const garminBits = g
    ? [
        g.status ? garminWord(g.status) : null,
        g.readiness != null
          ? `readiness ${Math.round(g.readiness)}${g.readinessLevel ? ` (${garminWord(g.readinessLevel).toLowerCase()})` : ""}`
          : null,
        g.hrvStatus ? `HRV ${garminWord(g.hrvStatus).toLowerCase()}` : null,
      ].filter((b): b is string => b != null)
    : [];
  return (
    <div className="card level-card">
      <Head
        title="🏃 Training load"
        value={t.ratio == null ? "—" : t.ratio.toFixed(2)}
        unit=" ratio"
        info={
          <>
            <p>
              Each workout counts by Garmin&apos;s training load for it — the
              heart-rate based number your watch adds up. Acute load is the
              last week of it, chronic load the last four weeks, both as a
              weekly figure, the way Garmin shows them. A workout without a
              Garmin load counts by its energy instead (a one-hour 600 kcal
              ride is 60).
            </p>
            <p>
              The number is acute ÷ chronic. 0.8–1.3 is building steadily; over
              1.5 is a jump your body hasn&apos;t been prepared for, when
              injuries and illness are more likely; under 0.8 you&apos;re easing
              off (good before a race, losing fitness if it lasts).
            </p>
            <p>
              When Garmin has sent its own acute and chronic load (with the
              optional sign-in), the ratio is Garmin&apos;s; the chart is
              always worked out here from your workouts.
            </p>
          </>
        }
      />
      {t.band ? (
        <Status label={t.band.label} tone={t.band.tone} extra={`${t.sessions7} workout${t.sessions7 === 1 ? "" : "s"} this week`} />
      ) : null}
      <div className="muted small level-caption">
        {t.ratio == null
          ? "Not enough training yet to read a ratio — it takes a few weeks of workouts."
          : `Acute ${Math.round(acute)} · chronic ${Math.round(chronic)}${fromGarmin ? " (Garmin)" : ""}.`}
        {garminBits.length > 0 && (
          <span style={{ display: "block" }}>Garmin: {garminBits.join(" · ")}.</span>
        )}
        {uncounted > 0 && (
          <span className="faint" style={{ display: "block" }}>
            {uncounted} of {t.workouts28} workouts in the last 4 weeks had no Garmin load and count by their calories.
          </span>
        )}
      </div>
      <MultiSpark
        since="60 days ago"
        lines={[
          { values: t.fitnessSeries, color: "var(--accent)", label: "chronic" },
          { values: t.fatigueSeries, color: "var(--warn)", label: "acute", dashed: true },
        ]}
      />
      <LoadFocusBars focus={t.focus} />
    </div>
  );
}

/**
 * Garmin's load-focus verdict in plain words: "AEROBIC_HIGH_SHORTAGE" →
 * "Short on high aerobic", "ANAEROBIC_FOCUS" → "Focused on anaerobic".
 */
function focusVerdict(phrase: string): string {
  const kind = phrase.startsWith("AEROBIC_HIGH")
    ? "high aerobic"
    : phrase.startsWith("AEROBIC_LOW")
      ? "low aerobic"
      : phrase.startsWith("ANAEROBIC")
        ? "anaerobic"
        : null;
  if (kind && phrase.endsWith("SHORTAGE")) return `Short on ${kind}`;
  if (kind && phrase.endsWith("FOCUS")) return `Focused on ${kind}`;
  return garminWord(phrase);
}

/**
 * The month's load by kind, one bar each. With Garmin's own split the target
 * range it set for each is shaded behind the bar; without, the bars show
 * each kind's share.
 */
function LoadFocusBars({ focus: f }: { focus: BodySnapshot["training"]["focus"] }) {
  const total = f.low + f.high + f.anaerobic;
  if (total <= 0) return null;
  const scale =
    Math.max(
      ...LOAD_FOCUS.map(({ key }) => Math.max(f[key], f.targets[key]?.max ?? 0)),
    ) * 1.1 || 1;
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  return (
    <div className="focus-block">
      <div className="focus-head">
        <span>Load focus · last 4 weeks{f.from === "garmin" ? " (Garmin)" : ""}</span>
        {f.feedback && <span className="focus-verdict">{focusVerdict(f.feedback)}</span>}
      </div>
      {LOAD_FOCUS.map(({ key, label }) => {
        const v = f[key];
        const target = f.targets[key];
        const under = target != null && v < target.min;
        const over = target != null && v > target.max;
        return (
          <div key={key} className="focus-row">
            <span className="focus-label">{label}</span>
            <span className="focus-track">
              {target && (
                <span
                  className="focus-target"
                  style={{ left: pct(target.min), width: `calc(${pct(target.max)} - ${pct(target.min)})` }}
                />
              )}
              <span
                className={`focus-fill focus-${key}${under || over ? " focus-off" : ""}`}
                style={{ width: pct(v) }}
              />
            </span>
            <span className="focus-value">
              {Math.round(v)}
              {target ? "" : <span className="faint"> · {Math.round((v / total) * 100)}%</span>}
            </span>
          </div>
        );
      })}
      <div className="faint small" style={{ marginTop: 4 }}>
        {f.targets.low || f.targets.high || f.targets.anaerobic
          ? "Shaded: the range Garmin aims you at for each."
          : "Sorted by what Garmin said each workout trained."}
        {f.unplaced > 0 &&
          ` ${Math.round(f.unplaced)} load from workouts without Garmin's detail isn't placed.`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------

function hm(h: number): string {
  const total = Math.round(h * 60);
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")}`;
}

export function SleepCard({ snap, onNeed }: { snap: Snap; onNeed: (h: number) => void }) {
  const s = snap.sleep;
  return (
    <div className="card level-card">
      <Head
        title="😴 Sleep debt"
        value={s.debtH.toFixed(1)}
        unit=" h"
        info={
          <>
            <p>
              Each night short of what you need adds to the debt; longer nights
              pay it back. Old debt fades — half of it in about{" "}
              {SLEEP.halfLifeNights} nights — so a bad night three weeks ago
              isn&apos;t still counting. Nights with no sleep synced are left out.
            </p>
            <p>How much sleep you need:</p>
            <SegPicker options={SLEEP.needs} value={s.needH} onChange={onNeed} format={(h) => `${h} h`} />
            <p>
              Most adults need 7–9 hours. If you wake without an alarm on holiday
              after a few days, that&apos;s about yours.
            </p>
          </>
        }
      />
      <Status label={s.band.label} tone={s.band.tone} />
      <div className="muted small level-caption">
        {s.nights14 === 0
          ? "No sleep synced in the last two weeks — Health Connect brings it in."
          : s.avg7H == null
            ? `No nights synced this week; need set to ${s.needH} h.`
            : `Averaging ${hm(s.avg7H)} over the last week, against ${s.needH} h.`}
      </div>
      <BandGauge
        value={s.debtH}
        scaleMax={15}
        bands={SLEEP_BANDS}
        ticks={[3, 6, 10]}
        lines={[6]}
        series={s.series}
        band={s.band}
        since={`${SLEEP_SHOWN_NIGHTS} nights ago`}
        format={(n) => `${n} h`}
      />
    </div>
  );
}
