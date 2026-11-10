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
  DRAIN_FIT_MIN_READINGS,
  FERRITIN,
  FERRITIN_BANDS,
  GLYCOGEN,
  KETONES,
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
import { DAY_MS, SLEEP_SHOWN_NIGHTS } from "../lib/body";

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
              Beta-alanine builds up carnosine in your muscles, the buffer
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
              The share of EPA and DHA (the marine omega-3s) in your red
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
        {advice} {o.test ? `From your test on ${dayLabel(o.test.day)}.` : "An estimate; a test pins it."}
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
      ? `Low. About ${f.ironForGood.toFixed(0)} mg iron a day would bring it toward 50, but low ferritin has other causes too, worth a word with a doctor.`
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
              Ferritin is how a blood test sees your stored iron: each µg/L is
              roughly {FERRITIN.mgPerUgL} mg in store. Under 30 is depleted,
              30–50 borderline (many feel it, especially athletes), 50–200 good.
            </p>
            <p>
              The body absorbs more iron when the store is low and less when
              it&apos;s full, so here absorption slides from ~17% to ~7%. The
              store loses about {FERRITIN.lossMgPerDay} mg a day, more with
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
        {advice} {f.test ? `From your test on ${dayLabel(f.test.day)}.` : "An estimate; a test pins it."}
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
                <b>{r.def.label}</b>: kept in {r.def.where}. Reference{" "}
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

/** "about 20% faster than" / "about 30% slower than" / null when it's the textbook's. */
function drainWords(drain: number): string | null {
  const pct = Math.round(Math.abs(drain - 1) * 100);
  if (pct === 0) return null;
  return `about ${pct}% ${drain > 1 ? "faster" : "slower"} than`;
}

export function GlycogenCard({ snap }: { snap: Snap }) {
  const g = snap.glycogen;
  const now = snap.at;
  const pct = Math.round(LIVER_KETOSIS * 100);
  // One line on the card; the rest is behind the ⓘ.
  let caption: string;
  if (!g.hasData) caption = "No carbs or workouts logged in the last few days.";
  else if (g.ketosisAt != null && g.ketosisAt <= now) caption = `Liver low: running on fat, ketones around ${g.ketone.toFixed(1)}.`;
  else if (g.ketosisAt != null) caption = `Under ${pct}% around ${clockDay(g.ketosisAt, now)} if you eat no more carbs.`;
  else caption = "Plenty in the liver for the next day.";

  const hasReadings = g.checks.some((c) => c.reading.ketone != null);
  const ketonePeak = Math.max(
    3,
    ...g.ketoneCurve.map((p) => p.amount),
    ...g.checks.map((c) => c.reading.ketone ?? 0),
  );
  return (
    <div className="card level-card">
      <Head
        title="🍞 Glycogen"
        value={Math.round(g.liver * 100)}
        unit="% liver"
        info={<GlycogenInfo snap={snap} />}
      />
      <div className="muted small level-caption">{caption}</div>
      <LevelCurve
        level={g.curve}
        now={now}
        color="var(--vitd)"
        threshold={pct}
        thresholdLabel="ketosis"
        glyph="🍞"
        minScale={100}
        overlay={{
          series: g.ketoneCurve,
          max: ketonePeak * 1.1,
          color: "var(--series-2)",
          dots: g.checks
            .filter((c) => c.reading.ketone != null)
            .map((c) => ({
              at: c.reading.at,
              value: c.reading.ketone ?? 0,
              title:
                `${(c.reading.ketone ?? 0).toFixed(1)} mmol/L at ${clock(c.reading.at)}` +
                (c.reading.glucose != null ? `, glucose ${c.reading.glucose.toFixed(1)}` : ""),
            })),
        }}
      />
      <div className="level-legend">
        <span>
          <i style={{ ["--key" as string]: "var(--vitd)" }} />
          liver
        </span>
        <span>
          <i style={{ ["--key" as string]: "var(--series-2)" }} />
          ketones, expected
        </span>
        {hasReadings && (
          <span>
            <i className="dot" style={{ ["--key" as string]: "var(--series-2)" }} />
            measured
          </span>
        )}
      </div>
      <MuscleSection snap={snap} />
    </div>
  );
}

/** A hard hour, for "what would a session cost": kcal, mostly from carbohydrate. */
const HARD_HOUR_KCAL = 600;

/**
 * Behind the glycogen card's ⓘ: first what the model says about today, in
 * its own numbers — what the last reading did, the fitted drain rate, what
 * went in and out of muscle — then how it works.
 */
function GlycogenInfo({ snap }: { snap: Snap }) {
  const g = snap.glycogen;
  const now = snap.at;
  const pct = Math.round(LIVER_KETOSIS * 100);

  // The newest ketone strip on the chart, and what it did to the estimate.
  const check = [...g.checks].reverse().find((c) => c.reading.ketone != null);
  const k = g.lastKetone;
  let reading: string;
  if (check && check.reading.ketone != null) {
    const r = check.reading;
    const before = Math.round(check.liverBefore * 100);
    const after = Math.round(check.liverAfter * 100);
    reading =
      `Your ketone reading of ${r.ketone!.toFixed(1)} mmol/L at ${clockDay(r.at, now)}` +
      (r.glucose != null ? ` (glucose ${r.glucose.toFixed(1)})` : "") +
      `: the model expected ${check.predictedKetone.toFixed(1)}, ` +
      (Math.abs(after - before) < 2
        ? "so it left the liver where it was."
        : `so it moved the liver from ${before}% to ${after}%.`);
  } else if (k) {
    reading = `Your last ketone reading was ${k.value.toFixed(1)} mmol/L at ${clockDay(k.at, now)}.`;
  } else {
    reading = "No ketone reading in the last two days, so this is the model on its own.";
  }
  const words = g.fit ? drainWords(g.fit.drain) : null;
  const fit = !g.fit
    ? `Not enough ketone readings yet to fit your own liver (it takes ${DRAIN_FIT_MIN_READINGS} in two months), so it empties at the textbook's pace.`
    : words
      ? `Going by ${g.fit.used} of your readings, your liver empties ${words} the textbook's.`
      : `Your last ${g.fit.used} readings fit the textbook's pace.`;

  const days = Math.round((now - g.muscleSinceMs) / DAY_MS);
  const n = g.muscleWorkouts.length;
  const refilled = Math.round(g.muscleRefilledG);
  const short = Math.max(0, Math.round(g.muscleCapG - g.muscleG));
  const hardHourG = ((HARD_HOUR_KCAL * GLYCOGEN.carbShareHard) / 4) * (1 - GLYCOGEN.workoutFromLiver);
  const afterHard = Math.max(0, Math.round(((g.muscleG - hardHourG) / g.muscleCapG) * 100));
  return (
    <>
      <h3>Right now</h3>
      <p>
        <strong>Liver {Math.round(g.liver * 100)}%</strong>, about {Math.round(g.liver * GLYCOGEN.liverCapG)} of{" "}
        {GLYCOGEN.liverCapG} g. A ketone strip should read around{" "}
        <strong>{g.ketone.toFixed(1)} mmol/L</strong>.{" "}
        {g.ketosisAt == null
          ? `It stays over ${pct}% for the next day.`
          : g.ketosisAt <= now
            ? `It's under ${pct}%, so the body is leaning on fat.`
            : `With no more carbs it drops under ${pct}% around ${clockDay(g.ketosisAt, now)}.`}
      </p>
      <p>{reading}</p>
      <p>{fit}</p>
      <p>
        <strong>Muscle {Math.round(g.muscle * 100)}%</strong>, about {Math.round(g.muscleG)} of{" "}
        {Math.round(g.muscleCapG)} g. Over the last {days} days{" "}
        {n === 0
          ? "no workouts took from it"
          : `${n} workout${n === 1 ? "" : "s"} took about ${Math.round(g.muscleBurnedG)} g`}{" "}
        and carbs put back about {refilled} g.{" "}
        {short < 10
          ? "It's full: more carbs go to the liver, then to fat."
          : `It's about ${short} g short of full; a hard hour would take about ${Math.round(hardHourG)} g more, down to ${afterHard}%.`}
      </p>

      <h3>The liver</h3>
      <p>
        About {GLYCOGEN.liverCapG} g of carbohydrate, which keeps your blood sugar up between meals. Net carbs you
        log refill it; your brain draws on it at about {GLYCOGEN.demandGPerH} g an hour, less as it empties: an
        overnight fast leaves it about half full, a day-long one nearly empty. Under {pct}% the body leans on fat and
        ketones climb: that&apos;s the dotted line on the chart.
      </p>

      <h3>Your meter</h3>
      <p>
        The thin line is the ketone level the liver predicts (about {KETONES.baseMmol} mmol/L when it&apos;s
        stocked, climbing through a fast) and the rings are what your meter showed. A reading corrects the
        estimate: raised ketones pull the liver down, low ones lift it.
      </p>
      <p>
        A glucose strip taken alongside says how far to trust it. Raised ketones with low glucose is fasting and
        counts in full; with high glucose, or just after a workout, it&apos;s more likely something else and counts
        for less. Glucose alone only matters when it reads low.
      </p>
      <p>
        Your readings also teach it. With {DRAIN_FIT_MIN_READINGS} or more ketone readings in the last two months,
        on days the diary or a fast accounts for, the model works out how fast your own liver empties and uses that
        from then on. Readings during a fast say the most; an ordinary morning now and then keeps the baseline
        honest.
      </p>

      <h3>Muscle</h3>
      <p>
        About {GLYCOGEN.musclePerKg} g per kg of body weight, which only the muscle itself can use. It moves two
        ways. A workout takes carbohydrate out of it: about {Math.round(GLYCOGEN.carbShareZone2 * 100)}% of the
        energy in zone 2, {Math.round(GLYCOGEN.carbShareHard * 100)}% when it&apos;s hard, more for sprints. Carbs
        beyond what the brain and liver take put it back, faster the emptier it is: about a day of carb-heavy eating
        after a hard session, two of eating normally. Rest and fasting leave it alone.
      </p>
      <p>
        Nothing you can measure at home checks this one, so read it as full, ready, drawn down or low rather than to
        the percent. A workout on a day with nothing else logged isn&apos;t counted, because the meals that refilled
        it aren&apos;t there either.
      </p>

      <h3>On the chart</h3>
      <p>
        🍞 marks carbs, 🏃 workouts. The liver curve ahead assumes you eat nothing more. The muscle line covers the
        last {days} days.
      </p>
    </>
  );
}

/** Muscle glycogen under the liver's chart: how full, and the last few days of it. */
function MuscleSection({ snap }: { snap: Snap }) {
  const g = snap.glycogen;
  const days = Math.round((snap.at - g.muscleSinceMs) / DAY_MS);
  const values = g.muscleSeries;
  return (
    <div className="muscle-section" style={{ ["--level" as string]: TONE_COLOR[g.muscleBand.tone] }}>
      <div className="muscle-head">
        <span className="muscle-title">Muscle</span>
        <span className="muscle-band">{g.muscleBand.label}</span>
        <span className="muscle-value">
          {Math.round(g.muscle * 100)}%
          <span className="muted"> · {Math.round(g.muscleG)} g</span>
        </span>
      </div>
      <div className="tank">
        <div className="tank-fill" style={{ width: `${Math.min(1, g.muscle) * 100}%` }} />
      </div>
      {values.length > 1 && (
        <>
          <svg className="store-spark muscle-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
            <polyline
              points={values
                .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(40 - v * 37).toFixed(1)}`)
                .join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="muscle-marks">
            {g.muscleWorkouts.map((w) => (
              <span
                key={w.at}
                style={{ left: `${((w.at - g.muscleSinceMs) / (snap.at - g.muscleSinceMs)) * 100}%` }}
                title={`${clockDay(w.at, snap.at)}: about ${Math.round(w.grams)} g`}
              >
                🏃
              </span>
            ))}
          </div>
          <div className="level-axis">
            <span>{days} days ago</span>
            <span>now</span>
          </div>
        </>
      )}
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
        value={t.ratio == null ? "–" : t.ratio.toFixed(2)}
        unit=" ratio"
        info={
          <>
            <p>
              Each workout counts by Garmin&apos;s training load for it: the
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
          ? "Not enough training yet to read a ratio. It takes a few weeks of workouts."
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
              pay it back. Old debt fades (half of it in about{" "}
              {SLEEP.halfLifeNights} nights), so a bad night three weeks ago
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
          ? "No sleep synced in the last two weeks. Health Connect brings it in."
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
