import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listFoodEntriesForRange } from "../lib/db";
import { shiftDay } from "../lib/daystamp";
import { DIET, dietWeek, summarizeDiet } from "../lib/diet";
import type { FoodEntry } from "../lib/types";

function Entries({ entries }: { entries: FoodEntry[] }) {
  return entries.length ? <ul className="diet-entries">{entries.map((e) => (
    <li key={e.id}><Link to={`/entry/meal/${e.id}`}>{e.title}</Link></li>
  ))}</ul> : <p className="muted small">No matching entries logged.</p>;
}

function Observation({ label, value, unknown, entries }: {
  label: string; value: string; unknown: number; entries: FoodEntry[];
}) {
  return <details className="diet-observation">
    <summary><span>{label}</span><strong>{value}</strong></summary>
    {unknown > 0 && <p className="muted small">{unknown} {unknown === 1 ? "entry still unknown" : "entries still unknown"}. Open a meal to review its diet observations.</p>}
    <Entries entries={entries} />
  </details>;
}

export default function DietCard({ day, refresh }: { day: string; refresh: number }) {
  const [data, setData] = useState<{ day: string; entries: FoodEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    const week = dietWeek(day);
    // Include neighbouring nights so an occasion spanning midnight is counted once.
    listFoodEntriesForRange(shiftDay(week.start, -1), shiftDay(week.end, 1))
      .then((entries) => { if (alive) setData({ day, entries }); })
      .catch(() => { if (alive) setError("Couldn't load diet observations."); });
    return () => { alive = false; };
  }, [day, refresh]);

  const s = data?.day === day ? summarizeDiet(data.entries, day) : null;
  return <DietSummary day={day} summary={s} error={error} />;
}

export function DietSummary({ day, summary: s, error = null }: {
  day: string; summary: ReturnType<typeof summarizeDiet> | null; error?: string | null;
}) {
  return <section className="diet-card" aria-label="Your diet">
    <div className="diet-heading"><h2>Your diet</h2><span>Vegetables first</span></div>
    {error ? <p role="alert" className="error-text">{error}</p> : !s ? <p className="muted small">Loading diet observations…</p> : <>
      <div className="diet-protein"><span>Protein · {day}</span><strong>{Math.round(s.proteinG)} <span>/ ~{DIET.proteinG} g</span></strong></div>
      <progress className="diet-progress" max={DIET.proteinG} value={Math.min(s.proteinG, DIET.proteinG)} aria-label="Protein logged toward 150 grams" />
      <p className="muted small">{s.today.length === 0 ? "No food logged for this day." : s.proteinUnknown > 0 ? `${s.proteinUnknown} ${s.proteinUnknown === 1 ? "entry has" : "entries have"} no protein estimate.` : "Estimated from logged food."}</p>
      <p className="diet-allowances">This week · Candy {s.candy.length}/{DIET.candyOccasions} · Drinks {s.alcohol.length}/{DIET.drinkingOccasions} occasions</p>
      {(s.candyUnknown > 0 || s.alcoholUnknown > 0) && <p className="muted small">Some entries are unclassified; weekly occasion counts are incomplete.</p>}
      <details className="diet-week">
        <summary><span>Week of {s.week.start}</span><span>{s.loggedDays}/7 days logged</span></summary>
        <p className="muted small">Monday–Sunday. Aim for vegetable-focused main meals and fewer, smaller refined-carb portions.</p>
        <Observation label="Vegetable-focused meals" value={`${s.vegetableMeals.length} / ${s.assessedMeals.length} assessed`} unknown={s.mainMealsUnknown} entries={s.assessedMeals} />
        <Observation label="Refined carbs" value={`${s.refined.length} entries`} unknown={s.refinedUnknown} entries={s.refined} />
        <Observation label="Candy" value={`${s.candy.length} / ${DIET.candyOccasions} occasions`} unknown={s.candyUnknown} entries={s.candy.flat()} />
        <Observation label="Drinks" value={`${s.alcohol.length} / ${DIET.drinkingOccasions} occasions`} unknown={s.alcoholUnknown} entries={s.alcohol.flat()} />
        {s.alcohol.length > 0 && <p className="muted small">{s.drinks} drinks recorded{s.drinksUnknown > 0 ? ` · ${s.drinksUnknown} quantities unknown` : ""}.</p>}
        <p className="muted small">Candy and drinks: up to twice a week; zero is fine. Logs within four hours form one occasion (up to twelve hours), counted on its starting day. You can correct this on a meal.</p>
        <details className="diet-observation"><summary>Review this week’s food</summary><Entries entries={s.entries} /></details>
        <p className="muted small">Only logged food is included. Missing meals and unclassified entries remain unknown.</p>
      </details>
    </>}
  </section>;
}
