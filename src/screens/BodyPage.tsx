/**
 * The Body tab: what's in you right now, then fasting.
 *
 * Caffeine and alcohol get a curve — where the day's doses have taken you and
 * where they'll take you if nothing else goes in — because the question
 * people bring is about the future: when can I sleep, when is it out of me.
 * Creatine and vitamin D move over weeks, so they get a store instead: how
 * full, and which way it's heading. Vitamin D, omega-3 and ferritin are shown
 * as estimated blood levels against the usual cut-offs, because "enough?" is
 * the question. Then glycogen, training load and sleep debt (BodyStores.tsx),
 * and fasting.
 *
 * All of it is read from the diary (lib/body.ts); nothing here is logged.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { onDiaryChanged } from "../lib/agent";
import { useGo } from "../lib/navigation";
import { setSetting } from "../lib/db";
import { SETTING_KEYS } from "../lib/types";
import {
  intakeStartDay,
  loadIntake,
  loadProfile,
  snapshotOf,
} from "../lib/body";
import type { BodyProfile, BodySnapshot, Intake } from "../lib/body";
import {
  CAFFEINE_HALF_LIVES,
  CAFFEINE_SLEEP_MG,
  CREATINE,
  CREATINE_WORKING,
  GRAMS_PER_DRINK,
  VITAMIN_D,
  VITAMIN_D_BANDS,
  VITAMIN_D_ENOUGH,
  VITAMIN_D_TARGET,
  WIDMARK_R,
} from "../lib/bodyModel";
import { shiftDay } from "../lib/daystamp";
import { todayStr } from "../lib/db";
import InfoButton from "../components/InfoButton";
import {
  BandGauge,
  LevelCurve,
  SegPicker,
  StoreBar,
  TONE_COLOR,
  clockDay,
  dayLabel,
  useGlide,
} from "../components/BodyCharts";
import {
  BetaAlanineCard,
  FerritinCard,
  GlycogenCard,
  Omega3Card,
  ReservesCard,
  SleepCard,
  TrainingCard,
} from "./BodyStores";
import FastingSection from "./FastingSection";

const WORKING_PCT = Math.round(CREATINE_WORKING * 100);

/** What the vitamin D number means and what to do about it, in a line. */
function vitaminDCaption(v: BodySnapshot["vitaminD"]): string {
  const source = v.test
    ? `From your blood test on ${dayLabel(v.test.day)}.`
    : "Estimated from an average sun year. Add a blood test to pin it.";
  const pace =
    v.avg30 >= 0.1 ? `At ${v.avg30.toFixed(1)} µg/day you'll be around ${Math.round(v.projected)} by ${dayLabel(v.projectedDay)}.` : "";
  let advice: string;
  if (v.level < VITAMIN_D_ENOUGH || v.projected < VITAMIN_D_ENOUGH) {
    advice = `Not enough stored. About ${Math.ceil(v.ugForEnough)} µg a day keeps you over ${VITAMIN_D_ENOUGH} through winter.`;
  } else if (v.avg30 + 0.5 < v.ugForEnough) {
    advice = `Enough for now, but winter will drain it. About ${Math.ceil(v.ugForEnough)} µg a day keeps you over ${VITAMIN_D_ENOUGH}.`;
  } else if (v.level < VITAMIN_D_TARGET) {
    advice = `Enough stored. ${Math.ceil(v.ugForTarget)} µg a day would keep you over ${VITAMIN_D_TARGET}, the higher target, all winter.`;
  } else if (v.level < 150) {
    advice = "Well stocked.";
  } else {
    advice = "Higher than it needs to be. There's no gain past 150.";
  }
  return [advice, pace, source].filter(Boolean).join(" ");
}

export default function BodyPage() {
  const [intake, setIntake] = useState<Intake | null>(null);
  const [profile, setProfile] = useState<BodyProfile | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const go = useGo();

  const load = useCallback(async () => {
    const today = todayStr();
    const p = await loadProfile();
    const i = await loadIntake(intakeStartDay(p, today), shiftDay(today, 1));
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

  async function changeSleepNeed(h: number) {
    await setSetting(SETTING_KEYS.sleepNeed, String(h));
    setProfile((p) => (p ? { ...p, sleepNeedH: h } : p));
  }

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
                    People clear it anywhere from 3 to 7 hours: slower on the pill
                    or when pregnant, faster for smokers. If late coffee keeps you
                    up, yours is probably on the long side. Your half-life:
                  </p>
                  <SegPicker
                    options={CAFFEINE_HALF_LIVES}
                    value={snap.profile.caffeineHalfLifeH}
                    onChange={(h) => void changeHalfLife(h)}
                    format={(h) => `${h} h`}
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
                    ? `Under ${CAFFEINE_SLEEP_MG} mg: clear for sleep.`
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
                    caffeine it clears at a steady rate, about{" "}
                    {Math.round(snap.profile.weightKg * 0.11)} g an hour at{" "}
                    {Math.round(snap.profile.weightKg)} kg
                    {snap.profile.weightKnown ? "" : " (assumed, no weight synced)"},
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
                    takes weeks, so this shows how full that store is, not what
                    you took today. Only creatine taken as a supplement counts; meat
                    keeps the baseline you start from.
                  </p>
                  <p>
                    Roughly: 3–5 g a day fills it in about four weeks, a 20 g
                    loading week in five or six days. Stop, and it drains back over
                    four to six weeks (half in about {CREATINE.halfLifeDays} days).
                    The line at {WORKING_PCT}% is roughly where it&apos;s working: the
                    card tells you until when you stay over it if you stopped
                    today. An average model: nobody&apos;s store is measured
                    without a biopsy.
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
                : snap.creatine.belowWorkingOn == null
                  ? `Under ${WORKING_PCT}%. About ${snap.creatine.daysToWorking} days of 5 g a day gets it back over.`
                  : `Over ${WORKING_PCT}% until ${dayLabel(snap.creatine.belowWorkingOn)} without more.`}
            </div>
            <StoreBar
              fraction={snap.creatine.fraction}
              series={snap.creatine.series}
              color="var(--accent)"
              threshold={CREATINE_WORKING}
              thresholdLabel={`${WORKING_PCT}%`}
              scaleMax={1}
            />
          </div>

          <BetaAlanineCard snap={snap} />

          <div className="card level-card">
            <div className="level-head">
              <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
                ☀️ Vitamin D
                <InfoButton title="Vitamin D">
                  <p>
                    Your estimated blood level of 25(OH)D, the stored form, and
                    what a blood test measures. Under {30} nmol/L is a deficiency,{" "}
                    {VITAMIN_D_ENOUGH} is enough for most people, and{" "}
                    {VITAMIN_D_TARGET} is the higher target some guidelines aim for.
                    Past 150 there&apos;s nothing more to gain.
                  </p>
                  <p>
                    It starts from where an unsupplemented northern-European level
                    sits at this time of year (around 70 in late summer, 40 by late
                    winter, when the sun is too low to make any) and adds what
                    you&apos;ve logged: each µg a day adds about{" "}
                    {VITAMIN_D.nmolPerUgDaily} nmol/L once it settles, and half of
                    it is gone {VITAMIN_D.halfLifeDays} days after you stop.
                  </p>
                  <p>
                    Sun habits, skin and weight move people a lot from the average,
                    so the best thing you can do is photograph a blood test into the
                    Library: the newest one with a vitamin D value (up to a year
                    old) sets where you are, and the model carries it forward.
                  </p>
                  {snap.vitaminD.test && (
                    <p>
                      Using your test from {dayLabel(snap.vitaminD.test.day)}:{" "}
                      {Math.round(snap.vitaminD.test.value)} nmol/L, which puts you{" "}
                      {Math.abs(Math.round(snap.vitaminD.offset))} nmol/L{" "}
                      {snap.vitaminD.offset >= 0 ? "above" : "below"} the average.
                    </p>
                  )}
                </InfoButton>
              </div>
              <div className="level-value">
                {snap.vitaminD.test ? "" : "~"}
                {Math.round(snap.vitaminD.level)}
                <span className="level-unit"> nmol/L</span>
              </div>
            </div>
            <div className="store-status" style={{ color: TONE_COLOR[snap.vitaminD.band.tone] }}>
              {snap.vitaminD.band.label}
              {snap.vitaminD.contribution >= 1 && (
                <span className="muted">
                  {" "}
                  · +{Math.round(snap.vitaminD.contribution)} from what you&apos;ve logged
                </span>
              )}
            </div>
            <div className="muted small level-caption">{vitaminDCaption(snap.vitaminD)}</div>
            <BandGauge
              value={snap.vitaminD.level}
              scaleMax={150}
              bands={VITAMIN_D_BANDS}
              ticks={[30, VITAMIN_D_ENOUGH, VITAMIN_D_TARGET]}
              lines={[VITAMIN_D_ENOUGH, VITAMIN_D_TARGET]}
              series={snap.vitaminD.series}
              band={snap.vitaminD.band}
            />
            {!snap.vitaminD.test && (
              <button
                type="button"
                className="btn btn-ghost store-link"
                onClick={() => go("/assistant/library")}
              >
                Add a blood test →
              </button>
            )}
          </div>

          <Omega3Card snap={snap} />
          <FerritinCard snap={snap} />
          <ReservesCard snap={snap} />

          <div className="section-title">Fuel</div>
          <GlycogenCard snap={snap} />

          <div className="section-title">Training</div>
          <TrainingCard snap={snap} />

          <div className="section-title">Sleep</div>
          <SleepCard snap={snap} onNeed={(h) => void changeSleepNeed(h)} />
        </>
      )}

      <FastingSection />
    </div>
  );
}
