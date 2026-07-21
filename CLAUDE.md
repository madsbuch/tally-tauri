# Tally

A Tauri (React + TypeScript + SQLite via drizzle) health/nutrition tracker.
The frontend lives in `src/`; the Rust shell in `src-tauri/`.

## JSON boundary rule

All untrusted JSON — SQLite JSON columns, LLM output, external API responses
(OpenRouter, Open Food Facts), and JSON blobs in the `settings` table — must be
parsed through a zod schema defined in `src/lib/schemas.ts`. Concretely:

- `JSON.parse` is only allowed inside `src/lib/schemas.ts` (via its `parseJson`
  helper). ESLint enforces this (`eslint.config.js`, run by `bun run lint` and
  as part of `bun run build`).
- Never cast parsed JSON with `as` — add or extend a schema in
  `src/lib/schemas.ts` and export a typed parse helper instead.
- Prefer inferring types from schemas (`z.infer`) over maintaining parallel
  interfaces. `ChatMessage`, `ToolCall`, `ContentPart`, and `ORModel` are
  already schema-derived.
- Schemas for model/API output should be forgiving (coerce + default, e.g.
  `.catch()` / transforms) so a sloppy answer degrades instead of failing;
  schemas for our own persisted data should be strict so corruption surfaces.
- Value-level coercion helpers like `sanitizeNutrients` (`src/lib/nutrients.ts`)
  are legitimate and used *inside* schemas — don't replace them with naive
  `z.number()` fields, their clamping semantics are intentional.

Note that drizzle's `.$type<T>()` on JSON columns is a compile-time claim only —
runtime validation still happens through the schema helpers
(e.g. `parseChatTranscript` for `chats.messages`).

## Commands

- `bun run dev` — Vite dev server
- `bun run build` — typecheck (`tsc`), lint, and bundle
- `bun run lint` — ESLint only
- `bun run tauri android build --apk` — Android build (CI does this)
