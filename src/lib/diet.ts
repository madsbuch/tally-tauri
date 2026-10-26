import { dayOf, shiftDay } from "./daystamp";
import type { FoodEntry } from "./types";
import type { DietObservations } from "./schemas";

// This is a personal app: these are the user's preferences, not presets to manage.
export const DIET = { proteinG: 150, candyOccasions: 2, drinkingOccasions: 2 } as const;
export const DIET_PREFERENCES =
  "Their diet preferences: vegetables should be the main part of most main meals; " +
  `around ${DIET.proteinG} g protein each day; up to ${DIET.candyOccasions} candy occasions and ` +
  `up to ${DIET.drinkingOccasions} drinking occasions per Monday–Sunday week; ` +
  "keep refined-carb portions (white bread, white rice, ordinary pasta) smaller and less frequent. " +
  "These are flexible preferences. Candy and alcohol limits are ceilings, never minimums or a recommendation to consume. " +
  "Do not treat fruit, legumes or whole grains as refined carbs. No invented carb gram limit. " +
  "Use logged evidence; missing observations and missing meals are unknown, not successes or failures. " +
  "Do not prescribe fasting or compensation for exceeding a preference. A drinking occasion does not describe quantity.";

export const DIET_OBSERVATION_PROMPT =
  "Include diet observations based on the food and user's description, independent of their goals: " +
  "main_meal (a breakfast, lunch or dinner, not a snack/drink), vegetable_forward (vegetables form the main part of the meal, not a garnish), " +
  "refined_carbs (contains white bread, white rice, ordinary pasta or other refined grains; not fruit, legumes or whole grains), " +
  "candy (sweets/chocolate, not every sweet food), alcohol (contains an alcoholic drink), " +
  "drinks (number of alcoholic drinks in this entry, not standard alcohol units; null if unknown), " +
  "occasion (optional unique label only if the user explicitly groups entries into one occasion; otherwise null). " +
  "Boolean fields are true, false, or null when uncertain. Do not infer absence from missing information. " +
  "On a correction, supply the complete updated diet object, retaining unchanged observations. " +
  "If a change makes an observation uncertain, set it to null.";

export const DIET_TOOL_SCHEMA = {
  type: "object",
  description: DIET_OBSERVATION_PROMPT,
  properties: {
    ...Object.fromEntries(
      ["main_meal", "vegetable_forward", "refined_carbs", "candy", "alcohol"].map((k) => [k, { type: ["boolean", "null"] }]),
    ),
    drinks: { type: ["number", "null"], minimum: 0 },
    occasion: { type: ["string", "null"], maxLength: 100 },
  },
  additionalProperties: false,
};

export const EMPTY_DIET: DietObservations = {
  main_meal: null, vegetable_forward: null, refined_carbs: null,
  candy: null, alcohol: null, drinks: null, occasion: null,
};

export const foodDay = (e: FoodEntry): string => e.day ?? dayOf(e.eaten_at, e.tz_offset_min);

export function dietWeek(day: string): { start: string; end: string } {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const start = shiftDay(day, -((weekday + 6) % 7));
  return { start, end: shiftDay(start, 6) };
}

/** Nearby logs form an occasion, even across midnight. A named occasion overrides this. */
export function dietOccasions(entries: FoodEntry[], kind: "candy" | "alcohol"): FoodEntry[][] {
  const groups: FoodEntry[][] = [];
  const named = new Map<string, FoodEntry[]>();
  let previous: FoodEntry[] | undefined;
  for (const e of [...entries].filter((e) => e.diet?.[kind] === true).sort((a, b) => a.eaten_at.localeCompare(b.eaten_at))) {
    const label = e.diet?.occasion?.trim();
    if (label) {
      const group = named.get(label);
      if (group) group.push(e);
      else { const fresh = [e]; named.set(label, fresh); groups.push(fresh); }
      previous = undefined;
      continue;
    }
    const last = previous?.[previous.length - 1];
    const first = previous?.[0];
    const at = Date.parse(e.eaten_at);
    if (last && first && at - Date.parse(last.eaten_at) <= 4 * 3_600_000 && at - Date.parse(first.eaten_at) <= 12 * 3_600_000) {
      previous!.push(e);
    } else {
      previous = [e];
      groups.push(previous);
    }
  }
  return groups;
}

export function summarizeDiet(entries: FoodEntry[], day: string) {
  const week = dietWeek(day);
  const inWeek = entries.filter((e) => foodDay(e) >= week.start && foodDay(e) <= week.end);
  const today = inWeek.filter((e) => foodDay(e) === day);
  const mainMeals = inWeek.filter((e) => e.diet?.main_meal === true);
  const assessedMeals = mainMeals.filter((e) => e.diet?.vegetable_forward != null);
  // An overnight occasion belongs to the local day on which it began.
  const occasions = (kind: "candy" | "alcohol") => dietOccasions(entries, kind).filter((g) => {
    const first = g[0];
    return first && foodDay(first) >= week.start && foodDay(first) <= week.end;
  });
  const candy = occasions("candy");
  const alcohol = occasions("alcohol");
  const alcoholEntries = alcohol.flat();
  return {
    week, entries: inWeek, today,
    proteinG: today.reduce((sum, e) => sum + (e.nutrients.protein_g ?? 0), 0),
    proteinUnknown: today.filter((e) => e.nutrients.protein_g == null).length,
    loggedDays: new Set(inWeek.map(foodDay)).size,
    assessedMeals,
    vegetableMeals: assessedMeals.filter((e) => e.diet?.vegetable_forward === true),
    mainMealsUnknown: inWeek.filter((e) => e.diet?.main_meal == null || (e.diet.main_meal && e.diet.vegetable_forward == null)).length,
    refined: inWeek.filter((e) => e.diet?.refined_carbs === true),
    refinedUnknown: inWeek.filter((e) => e.diet?.refined_carbs == null).length,
    candy, alcohol,
    candyUnknown: inWeek.filter((e) => e.diet?.candy == null).length,
    alcoholUnknown: inWeek.filter((e) => e.diet?.alcohol == null).length,
    drinks: alcoholEntries.reduce((sum, e) => sum + (e.diet?.drinks ?? 0), 0),
    drinksUnknown: alcoholEntries.filter((e) => e.diet?.drinks == null).length,
  };
}

export function renderDietSummary(entries: FoodEntry[], day: string): string {
  const s = summarizeDiet(entries, day);
  return `Diet observations, week ${s.week.start}–${s.week.end}, ${s.loggedDays} days logged: ` +
    `selected day ${s.proteinG.toFixed(0)}/${DIET.proteinG} g protein (${s.proteinUnknown} entries missing protein); ` +
    `vegetables main part of ${s.vegetableMeals.length}/${s.assessedMeals.length} assessed main meals (${s.mainMealsUnknown} entries unassessed); ` +
    `refined carbs in ${s.refined.length} entries (${s.refinedUnknown} unknown); ` +
    `candy ${s.candy.length}/${DIET.candyOccasions} occasions (${s.candyUnknown} unknown entries); ` +
    `alcohol ${s.alcohol.length}/${DIET.drinkingOccasions} occasions (${s.alcoholUnknown} unknown entries), ` +
    `${s.drinks} drinks recorded (${s.drinksUnknown} quantities unknown). ` +
    "Occasions group logs within four hours, capped at twelve hours, unless explicitly grouped; assigned to their starting day. " +
    "Totals only describe logged food; do not infer that any day is complete.";
}
