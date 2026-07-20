# Tally

Local-first fitness & lifestyle tracker built with Tauri 2 + React. All data
lives in a SQLite database on the device — there is no backend.

## Features

- **Food diary** — snap a photo of a meal; an OpenRouter vision model estimates
  macro- and micronutrients (26 tracked nutrients incl. sodium, magnesium,
  vitamin D, omega-3/6). Everything is editable before saving.
- **Supplements** — define supplements with per-dose nutrient contributions
  (AI-assisted estimation from the label text), one-tap logging, daily totals
  with omega-6:omega-3 ratio.
- **Fasting timer** — pick a goal (e.g. 16 h), get a sticky Android
  notification with a **live countdown** (chronometer-based: keeps ticking even
  when the app is killed) plus a completion alert.
- **OpenRouter integration** — bring your own API key, refresh the live model
  list in-app and switch to newer/more capable vision models any time.

## Data & privacy

- SQLite DB: app data dir → `tally.db` (food, supplements, fasts, settings).
- Photos: app data dir → `photos/`; they never leave the phone except as the
  base64 payload sent to the model you chose when you tap "Analyze".
- The OpenRouter API key is stored in the local DB only.

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

Install directly on the phone (USB debugging enabled):

```sh
"$ANDROID_HOME/platform-tools/adb" install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Or copy the APK to the phone and open it (allow "install unknown apps").

### Signing

Release builds are signed with `~/.tauri/keystores/tally-upload.jks`; the
credentials live in `src-tauri/gen/android/keystore.properties` (git-ignored).
Keep the keystore — Android only allows upgrades signed with the same key.

## Architecture notes

- `src/lib/` — typed data layer: SQLite access (`db.ts`), OpenRouter client
  (`openrouter.ts`), photo capture/compression (`photos.ts`), fasting logic
  (`fasting.ts`), canonical nutrient definitions (`nutrients.ts`).
- `src-tauri/plugins/fasting/` — custom Tauri mobile plugin (Rust + Kotlin).
  Posts an ongoing notification with `setUsesChronometer(true)` +
  `setChronometerCountDown(true)`, so Android renders the live countdown with
  zero polling; no-op on desktop/iOS.
- SQL migrations are defined in `src-tauri/src/lib.rs` and run on app start.
- The fast-completion alert is a scheduled notification
  (`@tauri-apps/plugin-notification`), delivered even if the app is closed.
