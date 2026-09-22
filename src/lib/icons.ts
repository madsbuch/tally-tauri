/**
 * Candidate icons for diary entries that have no photo.
 *
 * The AI picks one by KEY when it logs an entry (see the `icon` parameter on
 * log_meal / log_workout in lib/agent.ts) — so a tracked cup of coffee shows
 * ☕ instead of the generic 🍽. Keys are stored, not emoji: the glyph can be
 * retuned later without rewriting the database, and an unknown key (model
 * typo, removed icon) degrades to the keyword guess below rather than
 * rendering garbage.
 *
 * `keywords` powers `guessIconKey`, a purely local fallback used for entries
 * logged before this existed, for manual entries, and whenever the model
 * skipped the parameter.
 */

export type IconKind = "meal" | "workout";

export interface IconDef {
  /** Stable id stored in `food_entries.icon` / `workouts.icon`. */
  key: string;
  glyph: string;
  /** Human label for the picker in the entry editors. */
  label: string;
  kind: IconKind;
  /** Lowercase substrings that suggest this icon from a title. */
  keywords: string[];
}

export const MEAL_FALLBACK_GLYPH = "🍽";
export const WORKOUT_FALLBACK_GLYPH = "🏃";
/** Workouts synced from a watch keep their own marker. */
export const SYNCED_WORKOUT_GLYPH = "⌚";

export const ENTRY_ICONS: IconDef[] = [
  // -- Drinks ---------------------------------------------------------------
  { key: "coffee", glyph: "☕", label: "Coffee", kind: "meal",
    keywords: ["coffee", "espresso", "latte", "cappuccino", "americano", "flat white", "macchiato", "mocha", "cortado", "kaffe"] },
  { key: "tea", glyph: "🍵", label: "Tea", kind: "meal",
    keywords: ["tea", "matcha", "chai", "rooibos", "herbal infusion"] },
  { key: "water", glyph: "💧", label: "Water", kind: "meal",
    keywords: ["water", "sparkling water", "mineral water", "electrolyte"] },
  { key: "soda", glyph: "🧃", label: "Soda / juice", kind: "meal",
    keywords: ["soda", "cola", "coke", "pepsi", "soft drink", "lemonade", "juice", "energy drink", "squash"] },
  { key: "smoothie", glyph: "🥤", label: "Smoothie / shake", kind: "meal",
    keywords: ["smoothie", "shake", "protein shake", "milkshake", "frappe"] },
  { key: "dairy", glyph: "🥛", label: "Milk / yogurt", kind: "meal",
    keywords: ["milk", "yogurt", "yoghurt", "skyr", "kefir", "quark", "cottage cheese", "buttermilk"] },
  { key: "beer", glyph: "🍺", label: "Beer", kind: "meal",
    keywords: ["beer", "lager", "pilsner", "ale", "stout", "ipa", "cider"] },
  { key: "wine", glyph: "🍷", label: "Wine", kind: "meal",
    keywords: ["wine", "merlot", "riesling", "prosecco", "champagne", "rosé"] },
  { key: "cocktail", glyph: "🍸", label: "Cocktail / spirits", kind: "meal",
    keywords: ["cocktail", "gin", "vodka", "whisky", "whiskey", "rum", "negroni", "martini", "spritz", "tequila"] },

  // -- Breakfast & baking ---------------------------------------------------
  { key: "porridge", glyph: "🥣", label: "Porridge / cereal", kind: "meal",
    keywords: ["porridge", "oatmeal", "oats", "cereal", "muesli", "granola", "overnight oats", "havregrød"] },
  { key: "egg", glyph: "🍳", label: "Eggs", kind: "meal",
    keywords: ["egg", "eggs", "omelette", "omelet", "scrambled", "frittata", "poached"] },
  { key: "pancake", glyph: "🥞", label: "Pancakes / waffles", kind: "meal",
    keywords: ["pancake", "waffle", "crepe", "crêpe", "french toast"] },
  { key: "croissant", glyph: "🥐", label: "Pastry", kind: "meal",
    keywords: ["croissant", "pastry", "danish", "bun", "brioche", "scone", "wienerbrød"] },
  { key: "bread", glyph: "🍞", label: "Bread", kind: "meal",
    keywords: ["bread", "toast", "rye bread", "sourdough", "bagel", "rugbrød", "crispbread"] },
  { key: "sandwich", glyph: "🥪", label: "Sandwich", kind: "meal",
    keywords: ["sandwich", "wrap", "baguette", "panini", "smørrebrød"] },

  // -- Mains ----------------------------------------------------------------
  { key: "salad", glyph: "🥗", label: "Salad", kind: "meal",
    keywords: ["salad", "greens", "caesar", "poke bowl", "buddha bowl"] },
  { key: "soup", glyph: "🍲", label: "Soup / stew", kind: "meal",
    keywords: ["soup", "stew", "broth", "chili", "chilli", "casserole", "goulash", "suppe"] },
  { key: "pasta", glyph: "🍝", label: "Pasta", kind: "meal",
    keywords: ["pasta", "spaghetti", "lasagna", "lasagne", "carbonara", "bolognese", "penne", "tagliatelle"] },
  { key: "pizza", glyph: "🍕", label: "Pizza", kind: "meal",
    keywords: ["pizza", "calzone", "focaccia"] },
  { key: "burger", glyph: "🍔", label: "Burger", kind: "meal",
    keywords: ["burger", "cheeseburger", "hamburger", "slider"] },
  { key: "fries", glyph: "🍟", label: "Fries", kind: "meal",
    keywords: ["fries", "french fries", "pommes"] },
  { key: "taco", glyph: "🌮", label: "Taco / burrito", kind: "meal",
    keywords: ["taco", "burrito", "quesadilla", "enchilada", "nachos"] },
  { key: "sushi", glyph: "🍣", label: "Sushi", kind: "meal",
    keywords: ["sushi", "sashimi", "maki", "nigiri"] },
  { key: "noodles", glyph: "🍜", label: "Noodles / ramen", kind: "meal",
    keywords: ["ramen", "noodle", "noodles", "pho", "udon", "pad thai"] },
  { key: "rice", glyph: "🍚", label: "Rice", kind: "meal",
    keywords: ["rice", "risotto", "fried rice", "paella"] },
  { key: "curry", glyph: "🍛", label: "Curry", kind: "meal",
    keywords: ["curry", "dal", "dahl", "tikka", "masala", "korma"] },
  { key: "meat", glyph: "🥩", label: "Meat", kind: "meal",
    keywords: ["steak", "beef", "pork", "lamb", "meat", "roast", "schnitzel", "meatball", "bacon", "sausage"] },
  { key: "chicken", glyph: "🍗", label: "Chicken", kind: "meal",
    keywords: ["chicken", "poultry", "turkey", "duck", "kylling"] },
  { key: "fish", glyph: "🐟", label: "Fish", kind: "meal",
    keywords: ["fish", "salmon", "cod", "tuna", "mackerel", "herring", "trout", "laks"] },
  { key: "shrimp", glyph: "🦐", label: "Seafood", kind: "meal",
    keywords: ["shrimp", "prawn", "seafood", "mussels", "crab", "lobster", "squid"] },
  { key: "cheese", glyph: "🧀", label: "Cheese", kind: "meal",
    keywords: ["cheese", "brie", "cheddar", "parmesan", "feta", "ost"] },

  // -- Produce & snacks -----------------------------------------------------
  { key: "fruit", glyph: "🍎", label: "Fruit", kind: "meal",
    keywords: ["fruit", "apple", "pear", "banana", "orange", "berries", "berry", "grapes", "melon", "peach", "mango"] },
  { key: "vegetables", glyph: "🥦", label: "Vegetables", kind: "meal",
    keywords: ["vegetable", "veggies", "broccoli", "cauliflower", "spinach", "carrot", "asparagus"] },
  { key: "potato", glyph: "🥔", label: "Potato", kind: "meal",
    keywords: ["potato", "potatoes", "mash", "baked potato", "kartofler"] },
  { key: "avocado", glyph: "🥑", label: "Avocado", kind: "meal",
    keywords: ["avocado", "guacamole"] },
  { key: "nuts", glyph: "🥜", label: "Nuts", kind: "meal",
    keywords: ["nuts", "peanut", "almond", "cashew", "walnut", "trail mix", "pistachio"] },
  { key: "snack", glyph: "🍿", label: "Snack", kind: "meal",
    keywords: ["popcorn", "crisps", "potato chips", "snack", "pretzel", "chips"] },
  { key: "chocolate", glyph: "🍫", label: "Chocolate", kind: "meal",
    keywords: ["chocolate", "cocoa", "brownie", "chokolade", "protein bar", "energy bar", "granola bar"] },
  { key: "sweets", glyph: "🍬", label: "Sweets", kind: "meal",
    keywords: ["candy", "sweets", "licorice", "lakrids", "gummy", "marshmallow"] },
  { key: "cake", glyph: "🍰", label: "Cake", kind: "meal",
    keywords: ["cake", "tart", "pie", "cheesecake", "dessert", "kage"] },
  { key: "cookie", glyph: "🍪", label: "Cookie", kind: "meal",
    keywords: ["cookie", "biscuit", "småkage"] },
  { key: "icecream", glyph: "🍨", label: "Ice cream", kind: "meal",
    keywords: ["ice cream", "icecream", "gelato", "sorbet", "soft ice"] },
  { key: "donut", glyph: "🍩", label: "Donut", kind: "meal",
    keywords: ["donut", "doughnut"] },
  { key: "honey", glyph: "🍯", label: "Honey / jam", kind: "meal",
    keywords: ["honey", "jam", "syrup", "marmalade"] },
  { key: "meal", glyph: MEAL_FALLBACK_GLYPH, label: "Meal", kind: "meal",
    keywords: ["meal", "dinner", "lunch", "leftovers"] },

  // -- Workouts -------------------------------------------------------------
  { key: "run", glyph: "🏃", label: "Run", kind: "workout",
    keywords: ["run", "running", "jog", "treadmill", "5k", "10k", "marathon", "løb", "sprint"] },
  { key: "walk", glyph: "🚶", label: "Walk", kind: "workout",
    keywords: ["walk", "walking", "stroll", "steps", "gåtur"] },
  { key: "hike", glyph: "🥾", label: "Hike", kind: "workout",
    keywords: ["hike", "hiking", "trek", "trail walk"] },
  { key: "cycle", glyph: "🚴", label: "Cycling", kind: "workout",
    keywords: ["cycle", "cycling", "bike", "biking", "spinning", "ride", "cykel", "peloton"] },
  { key: "swim", glyph: "🏊", label: "Swim", kind: "workout",
    keywords: ["swim", "swimming", "pool", "svøm", "open water"] },
  { key: "strength", glyph: "🏋️", label: "Strength", kind: "workout",
    keywords: ["strength", "weights", "lifting", "gym", "deadlift", "squat", "bench", "crossfit", "styrke"] },
  { key: "yoga", glyph: "🧘", label: "Yoga / mobility", kind: "workout",
    keywords: ["yoga", "pilates", "stretch", "mobility", "meditation"] },
  { key: "rowing", glyph: "🚣", label: "Rowing", kind: "workout",
    keywords: ["row", "rowing", "erg", "kayak", "paddle"] },
  { key: "football", glyph: "⚽", label: "Football", kind: "workout",
    keywords: ["football", "soccer", "fodbold"] },
  { key: "basketball", glyph: "🏀", label: "Basketball", kind: "workout",
    keywords: ["basketball", "handball", "volleyball"] },
  { key: "racket", glyph: "🎾", label: "Racket sport", kind: "workout",
    keywords: ["tennis", "padel", "badminton", "squash", "table tennis", "ping pong"] },
  { key: "golf", glyph: "⛳", label: "Golf", kind: "workout", keywords: ["golf"] },
  { key: "climbing", glyph: "🧗", label: "Climbing", kind: "workout",
    keywords: ["climb", "climbing", "bouldering"] },
  { key: "ski", glyph: "⛷️", label: "Ski / snowboard", kind: "workout",
    keywords: ["ski", "skiing", "snowboard", "cross-country"] },
  { key: "boxing", glyph: "🥊", label: "Boxing / martial arts", kind: "workout",
    keywords: ["boxing", "kickbox", "martial", "mma", "judo", "karate", "bjj"] },
  { key: "dance", glyph: "💃", label: "Dance", kind: "workout",
    keywords: ["dance", "dancing", "zumba", "ballet"] },
  { key: "workout", glyph: "💪", label: "Workout", kind: "workout",
    keywords: ["workout", "training", "session", "exercise", "hiit", "circuit"] },
];

const BY_KEY = new Map(ENTRY_ICONS.map((i) => [i.key, i]));

/** Icon keys offered to the model, per entry kind. */
export function iconKeys(kind: IconKind): string[] {
  return ENTRY_ICONS.filter((i) => i.kind === kind).map((i) => i.key);
}

/** Icons offered in the entry editors, per kind. */
export function iconsFor(kind: IconKind): IconDef[] {
  return ENTRY_ICONS.filter((i) => i.kind === kind);
}

/** The emoji for a stored key, or null when the key is unknown/absent. */
export function iconGlyph(key: string | null | undefined): string | null {
  if (!key) return null;
  return BY_KEY.get(key)?.glyph ?? null;
}

/** True when `key` is one of the icons we actually offer. */
export function isIconKey(key: string | null | undefined): boolean {
  return key != null && BY_KEY.has(key);
}

/**
 * Best-effort icon for a title. The EARLIEST keyword wins, because entry
 * titles lead with the head noun: "Greek yogurt with berries" is yogurt, not
 * berries, and "Grilled salmon with potatoes" is salmon. Ties (two keywords
 * starting at the same word) go to the longer, more specific one. Returns
 * null when nothing matches — the caller uses the generic glyph then.
 */
export function guessIconKey(title: string, kind: IconKind): string | null {
  const hay = ` ${title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  let best: { key: string; at: number; len: number } | null = null;
  for (const icon of ENTRY_ICONS) {
    if (icon.kind !== kind) continue;
    for (const raw of icon.keywords) {
      const kw = raw.trim();
      // Bounded by spaces so "is" never matches inside "crisps"; the plural
      // form is checked too, so one keyword covers "egg" and "eggs".
      let at = hay.indexOf(` ${kw} `);
      if (at === -1) at = hay.indexOf(` ${kw}s `);
      if (at === -1) continue;
      if (best == null || at < best.at || (at === best.at && kw.length > best.len)) {
        best = { key: icon.key, at, len: kw.length };
      }
    }
  }
  return best?.key ?? null;
}

/**
 * The glyph to show for an entry with no photo: the AI's (or the user's)
 * pick, else a keyword guess from the title, else the generic glyph.
 */
export function entryGlyph(
  icon: string | null | undefined,
  title: string,
  kind: IconKind,
): string {
  return (
    iconGlyph(icon) ??
    iconGlyph(guessIconKey(title, kind)) ??
    (kind === "meal" ? MEAL_FALLBACK_GLYPH : WORKOUT_FALLBACK_GLYPH)
  );
}
