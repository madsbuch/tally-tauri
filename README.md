# Tally

Local-first fitness & lifestyle tracker built with Tauri 2 + React. All data
lives in a SQLite database on the device — there is no backend.

## Features

- **Fire-and-forget photo diary** — take a picture (plus an optional note like
  "ate this earlier today"), tap Add, done. The capture appears in the
  timeline instantly as "Analyzing…" while a background agent — armed with
  the current time and your supplement catalog — decides what it is and
  records it via tool calls (`log_meal` / `log_workout` / `log_supplement`),
  resolving relative times itself. One capture can log several items. Failed
  analyses stay in the timeline with a retry; interrupted ones resume on next
  launch. Meals get 38-nutrient estimates; workout screenshots become negative
  calories; unknown supplement names create catalog entries automatically.
- **Open Food Facts lookup** — the diary agent and the assistant can search
  the free Open Food Facts database, so branded/packaged products get real
  label nutrition instead of an estimate (missing micronutrients are still
  estimated by the model). Only the product name or barcode is sent — never
  photos or personal data.
- **Nutrients page** — macro/micro overview over a day, week, or month
  (multi-day spans show per-day averages): energy in/burned/net, macro split,
  and every micronutrient against adult reference intakes, filterable by
  source (food vs supplements), with the omega-6:omega-3 ratio. Creatine and
  caffeine live in their own "Other" section — creatine against a 5 g/day
  supplementation target.
- **Garmin / Health Connect sync** — workouts your watch records (calories,
  distance, avg heart rate) flow in automatically via Android Health Connect.
  Enable Health Connect in the Garmin Connect app, tap "Connect" in Tally's
  settings, done: every app start pulls new exercise sessions into the diary
  (deduped by Health Connect record id, so re-syncs never duplicate) and the
  calories count against the day's energy math. Fully on-device — no Garmin
  account access, no cloud.
- **Fasting timer** — built for multi-day fasts (48 h/72 h presets, custom to
  168 h). A sticky Android notification shows a **live countdown**
  (chronometer-based: keeps ticking even when the app is killed) plus an
  exact-alarm completion alert.
- **Streak & achievements** — a logging streak (🔥 in the Diary header) that
  counts any logged day; multi-day fasts count too, and every 7 straight days
  banks a freeze token (max 3) that auto-covers a missed day. Tapping the
  streak opens 30 achievements across logging, smart captures, fasting,
  nutrition quality, training and Garmin-synced body metrics — deliberately
  no daily-calorie-budget mechanics, since banking calories via fasting is a
  supported pattern. The Fasting page also shows lifetime records (longest
  fast, hours fasted, goals hit) and flags a new personal record live.
- **OpenRouter integration** — bring your own API key, refresh the live model
  list in-app, and switch to newer/more capable vision models any time.

## Data & privacy

- **Export**: Settings → Your data → Export database produces a consistent
  `VACUUM INTO` snapshot of the raw SQLite DB and hands it to the Android
  share sheet (desktop: shows the file path).
- SQLite DB: app data dir → `tally.db`. Photos: app data dir → `photos/`;
  they never leave the phone except as the payload sent to the model you chose
  when you tap "Analyze". The API key is stored in the local DB only.

## Architecture

- **SQLite runs in Rust** (`tauri-plugin-sql`/sqlx). **Drizzle** is the typed
  query layer in TS (`src/db/schema.ts` is the source of truth), talking to the
  plugin through `drizzle-orm/sqlite-proxy` (`src/lib/db.ts`).
- **Migrations**: `drizzle-kit` generates versioned SQL from schema changes.
  Workflow for evolving the schema:

  ```sh
  # 1. edit src/db/schema.ts
  bunx drizzle-kit generate --name add_my_column
  # 2. register the new file in src-tauri/src/lib.rs migrations() with the
  #    next version number — it runs automatically on app start.
  ```

  Note: `serde_json`'s `preserve_order` feature (src-tauri/Cargo.toml) is
  required — the sqlite-proxy maps rows positionally.
- `src-tauri/plugins/fasting/` — custom Tauri mobile plugin (Rust + Kotlin).
  Posts an ongoing notification with `setUsesChronometer(true)` +
  `setChronometerCountDown(true)`; no-op on desktop/iOS.
- `src-tauri/plugins/health-connect/` — custom Tauri mobile plugin (Rust +
  Kotlin) over `androidx.health.connect:connect-client`. Commands: status /
  permission request / read exercise sessions (with per-session aggregates
  for calories, distance, avg HR); no-op on desktop/iOS. The sync logic lives
  in `src/lib/healthConnect.ts` — it upserts sessions into `workouts` keyed
  on the Health Connect record UID (`external_id` column) and runs on app
  start plus on demand from Settings.
- `src/lib/agent.ts` — the diary agent: captures are stored in a `captures`
  table, then a background tool-calling loop (OpenRouter `tools`) executes
  `log_meal`/`log_workout`/`log_supplement` against the local DB. Pick a
  vision model that supports tool calling (the Settings picker filters for
  this).
- `src/lib/openrouter.ts` — model listing, tool-calling chat, and one-shot
  analysis helpers used by the manual entry path.
- `src/lib/openFoodFacts.ts` — the shared `search_packaged_food` tool: Open
  Food Facts name/barcode lookup with label nutrition mapped onto Tally's
  nutrient keys (per 100 g and per serving). Used by both the diary agent and
  the assistant.

## Development

```sh
bun install
bun run tauri dev            # desktop dev window
bun run tauri android dev    # dev on a connected Android device
```

Required env for Android builds (asdf-managed JDK):

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.0.12674087"
export JAVA_HOME="$HOME/.asdf/installs/java/temurin-17.0.13+11"
```

## Building & installing the APK

```sh
bun run tauri android build --apk --target aarch64
```

Output: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`

Install directly (USB debugging enabled):

```sh
"$ANDROID_HOME/platform-tools/adb" install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Or copy the APK to the phone and open it (allow "install unknown apps").

### Signing

Release builds are signed with `~/.tauri/keystores/tally-upload.jks`; the
credentials live in `src-tauri/gen/android/keystore.properties` (git-ignored).
Keep the keystore — Android only allows upgrades signed with the same key.
