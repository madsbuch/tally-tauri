# Tally

Local-first fitness & lifestyle tracker built with Tauri 2 + React. All data
lives in a SQLite database on the device — there is no backend.

## Features

- **Photo-first diary** — take a picture; the AI decides what it is. Food gets
  macro- and micronutrient estimates (26 tracked nutrients incl. sodium,
  magnesium, vitamin D, omega-3/6); a workout-app screenshot becomes an
  exercise entry with negative calories. Supplements are logged with one tap
  from your personal catalog. Everything is editable before saving.
- **Nutrients page** — daily macro/micro overview: energy in/burned/net, macro
  split, and every micronutrient against adult reference intakes, filterable
  by source (food vs supplements), with the omega-6:omega-3 ratio.
- **Fasting timer** — built for multi-day fasts (48 h/72 h presets, custom to
  168 h). A sticky Android notification shows a **live countdown**
  (chronometer-based: keeps ticking even when the app is killed) plus an
  exact-alarm completion alert.
- **OpenRouter integration** — bring your own API key, refresh the live model
  list in-app, and switch to newer/more capable vision models any time.

## Data & privacy

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
- `src/lib/openrouter.ts` — model listing + unified `analyzePhoto` (the model
  classifies meal vs workout in one call), plus supplement label estimation.

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
