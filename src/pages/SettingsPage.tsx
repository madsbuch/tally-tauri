import { useEffect, useMemo, useRef, useState } from "react";
import { deleteSetting, getSetting, setSetting } from "../lib/db";
import {
  chat,
  fetchModels,
  isVisionModel,
  promptPricePerMillion,
  supportsTools,
} from "../lib/openrouter";
import {
  DEFAULT_FAST_HOURS,
  DEFAULT_KETO_NET_CARB_LIMIT_G,
  DEFAULT_VISION_MODEL,
  SETTING_KEYS,
} from "../lib/types";
import type { ORModel } from "../lib/types";
import {
  getHealthConnectStatus,
  openHealthConnectSettings,
  requestHealthConnectPermissions,
  syncHealthConnectWorkouts,
} from "../lib/healthConnect";
import type { HealthConnectStatus } from "../lib/healthConnect";

const MAX_LIST_ROWS = 40;

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok" }
  | { status: "error"; message: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "sk-or-…1234" style mask: recognizable head, last 4 chars. */
function maskKey(key: string): string {
  // Short keys would be fully revealed by head+tail — mask entirely.
  if (key.length <= 8) return "••••";
  const tail = key.slice(-4);
  const head = key.startsWith("sk-or-") ? "sk-or-" : key.slice(0, 4);
  return `${head}…${tail}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

function priceLabel(m: ORModel): string | null {
  const p = promptPricePerMillion(m);
  if (p == null) return null;
  if (p === 0) return "free";
  return `$${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}/M tokens`;
}

function modelSub(m: ORModel): string {
  const parts: string[] = [m.id];
  const price = priceLabel(m);
  if (price) parts.push(price);
  if (m.context_length) parts.push(`${Math.round(m.context_length / 1000)}k context`);
  return parts.join(" · ");
}

/** A tappable model row with a checkmark when selected. */
function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: ORModel;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className="list-row"
      onClick={() => onSelect(model.id)}
      style={{
        font: "inherit",
        color: "inherit",
        textAlign: "left",
        width: "100%",
        cursor: "pointer",
        ...(selected ? { borderColor: "var(--accent)" } : {}),
      }}
    >
      <div className="row-main">
        <div className="row-title">{model.name}</div>
        <div className="row-sub">{modelSub(model)}</div>
      </div>
      {selected && (
        <div className="row-end" style={{ color: "var(--accent)", fontWeight: 700 }}>
          ✓
        </div>
      )}
    </button>
  );
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);

  // OpenRouter API key
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  // Vision model
  const [models, setModels] = useState<ORModel[]>([]);
  const [cacheAt, setCacheAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_VISION_MODEL);

  // Garmin / Health Connect
  const [hcStatus, setHcStatus] = useState<HealthConnectStatus | null>(null);
  const [hcLastSync, setHcLastSync] = useState<string | null>(null);
  const [hcBusy, setHcBusy] = useState(false);
  const [hcMessage, setHcMessage] = useState<string | null>(null);
  const [hcError, setHcError] = useState<string | null>(null);

  // Fasting
  const [fastHours, setFastHours] = useState(String(DEFAULT_FAST_HOURS));
  const [fastSaved, setFastSaved] = useState(false);
  const fastSavedTimer = useRef<number | null>(null);
  const lastFastHoursRef = useRef(String(DEFAULT_FAST_HOURS));

  // Keto
  const [carbLimit, setCarbLimit] = useState(String(DEFAULT_KETO_NET_CARB_LIMIT_G));
  const [carbSaved, setCarbSaved] = useState(false);
  const carbSavedTimer = useRef<number | null>(null);
  const lastCarbLimitRef = useRef(String(DEFAULT_KETO_NET_CARB_LIMIT_G));

  const bootedRef = useRef(false);

  async function refreshModels(silent: boolean) {
    setRefreshing(true);
    if (!silent) setRefreshError(null);
    try {
      const list = await fetchModels();
      const at = new Date().toISOString();
      setModels(list);
      setCacheAt(at);
      setRefreshError(null);
      await setSetting(SETTING_KEYS.modelsCache, JSON.stringify(list));
      await setSetting(SETTING_KEYS.modelsCacheAt, at);
    } catch (e) {
      // Offline is fine on the silent boot refresh.
      if (!silent) setRefreshError(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      try {
        const [key, model, cache, at, hours, carbs, hcAt] = await Promise.all([
          getSetting(SETTING_KEYS.openrouterApiKey),
          getSetting(SETTING_KEYS.visionModel),
          getSetting(SETTING_KEYS.modelsCache),
          getSetting(SETTING_KEYS.modelsCacheAt),
          getSetting(SETTING_KEYS.fastDefaultHours),
          getSetting(SETTING_KEYS.ketoNetCarbLimit),
          getSetting(SETTING_KEYS.healthConnectLastSyncAt),
        ]);
        setHcLastSync(hcAt);
        void getHealthConnectStatus().then(setHcStatus);
        setSavedKey(key);
        if (model) setSelectedModel(model);
        if (hours) {
          setFastHours(hours);
          lastFastHoursRef.current = hours;
        }
        if (carbs) {
          setCarbLimit(carbs);
          lastCarbLimitRef.current = carbs;
        }
        let cached: ORModel[] | null = null;
        if (cache) {
          try {
            const raw = JSON.parse(cache);
            if (Array.isArray(raw)) cached = raw as ORModel[];
          } catch {
            cached = null;
          }
        }
        if (cached && cached.length > 0) {
          setModels(cached);
          setCacheAt(at);
        } else {
          void refreshModels(true);
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      if (fastSavedTimer.current != null) window.clearTimeout(fastSavedTimer.current);
      if (carbSavedTimer.current != null) window.clearTimeout(carbSavedTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    setSavedKey(key);
    setKeyInput("");
    setShowKey(false);
    setTest({ status: "idle" });
    await setSetting(SETTING_KEYS.openrouterApiKey, key);
  }

  async function removeKey() {
    if (!window.confirm("Remove the OpenRouter API key from this device?")) return;
    setSavedKey(null);
    setTest({ status: "idle" });
    await deleteSetting(SETTING_KEYS.openrouterApiKey);
  }

  async function testConnection() {
    if (!savedKey) return;
    setTest({ status: "testing" });
    try {
      await chat(savedKey, selectedModel, [
        { role: "user", content: "Reply with exactly: OK" },
      ]);
      setTest({ status: "ok" });
    } catch (e) {
      setTest({ status: "error", message: errorMessage(e) });
    }
  }

  async function selectModel(id: string) {
    setSelectedModel(id);
    setTest({ status: "idle" });
    await setSetting(SETTING_KEYS.visionModel, id);
  }

  function commitFastHours() {
    const n = parseFloat(fastHours);
    // Empty/invalid input: restore the last committed value, don't overwrite.
    if (!isFinite(n)) {
      setFastHours(lastFastHoursRef.current);
      return;
    }
    // Fasts can be multi-day; keep fractional hours (0.5 steps).
    const clamped = Math.min(168, Math.max(1, Math.round(n * 10) / 10));
    const str = String(clamped);
    setFastHours(str);
    if (str === lastFastHoursRef.current) return;
    lastFastHoursRef.current = str;
    void setSetting(SETTING_KEYS.fastDefaultHours, str).then(() => {
      setFastSaved(true);
      if (fastSavedTimer.current != null) window.clearTimeout(fastSavedTimer.current);
      fastSavedTimer.current = window.setTimeout(() => setFastSaved(false), 1500);
    });
  }

  async function runHcSync() {
    setHcBusy(true);
    setHcError(null);
    setHcMessage(null);
    try {
      const res = await syncHealthConnectWorkouts();
      setHcStatus(res.status);
      const at = new Date().toISOString();
      setHcLastSync(at);
      setHcMessage(
        res.synced === 0
          ? "Up to date — no workouts in the sync window."
          : `Synced ${res.synced} workout${res.synced === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setHcError(errorMessage(e));
    } finally {
      setHcBusy(false);
    }
  }

  async function connectHc() {
    setHcBusy(true);
    setHcError(null);
    setHcMessage(null);
    try {
      const granted = await requestHealthConnectPermissions();
      const status = await getHealthConnectStatus();
      setHcStatus(status);
      if (granted) {
        await runHcSync();
      } else {
        setHcError(
          "Permissions weren't granted. If no dialog appeared, grant Tally access " +
            "manually in the Health Connect app (App permissions → Tally).",
        );
      }
    } catch (e) {
      setHcError(errorMessage(e));
    } finally {
      setHcBusy(false);
    }
  }

  function commitCarbLimit() {
    const n = parseFloat(carbLimit);
    // Empty/invalid input: restore the last committed value, don't overwrite.
    if (!isFinite(n)) {
      setCarbLimit(lastCarbLimitRef.current);
      return;
    }
    const clamped = Math.min(150, Math.max(5, Math.round(n)));
    const str = String(clamped);
    setCarbLimit(str);
    if (str === lastCarbLimitRef.current) return;
    lastCarbLimitRef.current = str;
    void setSetting(SETTING_KEYS.ketoNetCarbLimit, str).then(() => {
      setCarbSaved(true);
      if (carbSavedTimer.current != null) window.clearTimeout(carbSavedTimer.current);
      carbSavedTimer.current = window.setTimeout(() => setCarbSaved(false), 1500);
    });
  }

  const visionModels = useMemo(() => {
    const list = models.filter((m) => isVisionModel(m) && supportsTools(m));
    list.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    return list;
  }, [models]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) {
      return visionModels.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      );
    }
    // No search: pin the selected model at the top.
    const sel = visionModels.find((m) => m.id === selectedModel);
    return sel
      ? [sel, ...visionModels.filter((m) => m.id !== selectedModel)]
      : visionModels;
  }, [visionModels, search, selectedModel]);

  const shown = filtered.slice(0, MAX_LIST_ROWS);
  const hiddenCount = filtered.length - shown.length;
  const selectedInfo = models.find((m) => m.id === selectedModel) ?? null;

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-title">Settings</h1>
        </header>
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>

      {/* OpenRouter ------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-title">OpenRouter</h2>
        <div className="field">
          <label className="label" htmlFor="or-key">
            API key
          </label>
          <div className="input-row">
            <input
              id="or-key"
              className="input"
              type={showKey ? "text" : "password"}
              placeholder="sk-or-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              className="btn btn-ghost"
              style={{ flex: "0 0 auto" }}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? "Hide" : "Show"}
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: "0 0 auto" }}
              onClick={() => void saveKey()}
              disabled={!keyInput.trim()}
            >
              Save
            </button>
          </div>
        </div>
        {savedKey ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="chip chip-accent">Key saved · {maskKey(savedKey)}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => void removeKey()}>
              Remove
            </button>
          </div>
        ) : (
          <div className="muted small">No API key saved yet.</div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <button
            className="btn btn-sm"
            onClick={() => void testConnection()}
            disabled={!savedKey || test.status === "testing"}
          >
            Test connection
          </button>
          {test.status === "testing" && <div className="spinner" />}
          {test.status === "ok" && <span className="chip chip-accent">✓ Working</span>}
        </div>
        {test.status === "error" && (
          <div className="error-text" style={{ marginTop: 8 }}>
            {test.message}
          </div>
        )}
        <p className="muted small" style={{ margin: "12px 0 0" }}>
          Stored only on this device. Create keys at openrouter.ai/keys.
        </p>
      </div>

      {/* Vision model ------------------------------------------------------ */}
      <div className="card">
        <h2 className="card-title">Vision model</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Analyzes your captures and logs diary entries. Vision models with tool
          calling — the diary agent needs both.
        </p>
        <div
          className="list-row"
          style={{ background: "var(--bg-elev)", marginBottom: 10 }}
        >
          <div className="row-main">
            <div className="row-title">{selectedInfo?.name ?? selectedModel}</div>
            <div className="row-sub">
              {selectedInfo ? modelSub(selectedInfo) : "Not in cached list"}
            </div>
          </div>
          <div className="row-end" style={{ color: "var(--accent)", fontWeight: 700 }}>
            ✓
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <button
            className="btn btn-sm"
            onClick={() => void refreshModels(false)}
            disabled={refreshing}
          >
            Refresh models
          </button>
          {refreshing ? (
            <div className="spinner" />
          ) : (
            models.length > 0 &&
            cacheAt && (
              <span className="faint small">
                {models.length} models · refreshed {relativeTime(cacheAt)}
              </span>
            )
          )}
        </div>
        {refreshError && (
          <div className="error-text" style={{ marginBottom: 8 }}>
            {refreshError}
          </div>
        )}
        <div className="field" style={{ marginBottom: 8 }}>
          <input
            className="input"
            placeholder="Search vision models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        {visionModels.length === 0 ? (
          refreshing ? (
            <div className="empty">
              <div className="spinner" style={{ margin: "0 auto" }} />
            </div>
          ) : (
            <div className="empty">
              <div className="empty-icon">📡</div>
              No models cached yet. Tap “Refresh models”.
            </div>
          )
        ) : shown.length === 0 ? (
          <div className="empty">No vision models match “{search.trim()}”.</div>
        ) : (
          <div className="list">
            {shown.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                selected={m.id === selectedModel}
                onSelect={(id) => void selectModel(id)}
              />
            ))}
            {hiddenCount > 0 && (
              <div className="faint small" style={{ textAlign: "center", padding: "6px 0" }}>
                …and {hiddenCount} more — refine your search
              </div>
            )}
          </div>
        )}
      </div>

      {/* Fasting ----------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-title">Fasting</h2>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="fast-hours">
            Default goal hours
          </label>
          <div className="input-row" style={{ alignItems: "center" }}>
            <input
              id="fast-hours"
              className="input"
              type="number"
              min={1}
              max={168}
              step={0.5}
              inputMode="numeric"
              value={fastHours}
              onChange={(e) => setFastHours(e.target.value)}
              onBlur={commitFastHours}
            />
            {fastSaved && (
              <span className="chip chip-accent" style={{ flex: "0 0 auto" }}>
                Saved
              </span>
            )}
          </div>
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            Used when starting a new fast (1–168 hours — multi-day fasts welcome).
          </p>
        </div>
      </div>

      {/* Garmin / Health Connect ------------------------------------------- */}
      <div className="card">
        <h2 className="card-title">Garmin watch sync</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Pulls workouts (calories, distance, heart rate) that Garmin Connect
          writes into Android Health Connect. Enable “Health Connect” in the
          Garmin Connect app first, then connect Tally here. Everything stays
          on this device.
        </p>
        {hcStatus === null ? (
          <div className="spinner" />
        ) : hcStatus.availability === "unavailable" ? (
          <p className="muted small" style={{ margin: 0 }}>
            Health Connect isn’t available here — it needs an Android phone
            with the Health Connect app (built into Android 14+).
          </p>
        ) : hcStatus.availability === "updateRequired" ? (
          <p className="muted small" style={{ margin: 0 }}>
            The Health Connect app needs an update before Tally can read from
            it. Update it in the Play Store, then come back.
          </p>
        ) : !hcStatus.permissionsGranted ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              className="btn btn-primary"
              onClick={() => void connectHc()}
              disabled={hcBusy}
            >
              Connect Health Connect
            </button>
            {hcBusy && <div className="spinner" />}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="chip chip-accent">✓ Connected</span>
              <button
                className="btn btn-sm"
                onClick={() => void runHcSync()}
                disabled={hcBusy}
              >
                Sync now
              </button>
              {hcBusy && <div className="spinner" />}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void openHealthConnectSettings().catch(() => {})}
              >
                Open Health Connect
              </button>
            </div>
            <p className="faint small" style={{ margin: "10px 0 0" }}>
              Workouts sync automatically when the app opens
              {hcLastSync ? ` · last sync ${relativeTime(hcLastSync)}` : ""}.
              Synced entries are matched by their Health Connect id, so
              re-syncing never duplicates.
            </p>
          </>
        )}
        {hcMessage && (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            {hcMessage}
          </p>
        )}
        {hcError && (
          <div className="error-text" style={{ marginTop: 8 }}>
            {hcError}
          </div>
        )}
      </div>

      {/* Keto -------------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-title">Keto</h2>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="keto-carb-limit">
            Daily net-carb limit (g)
          </label>
          <div className="input-row" style={{ alignItems: "center" }}>
            <input
              id="keto-carb-limit"
              className="input"
              type="number"
              min={5}
              max={150}
              step={1}
              inputMode="numeric"
              value={carbLimit}
              onChange={(e) => setCarbLimit(e.target.value)}
              onBlur={commitCarbLimit}
            />
            {carbSaved && (
              <span className="chip chip-accent" style={{ flex: "0 0 auto" }}>
                Saved
              </span>
            )}
          </div>
          <p className="muted small" style={{ margin: "8px 2px 0" }}>
            The Keto card on the Nutrients page tracks net carbs (carbs − fiber)
            against this budget. Strict keto is usually 20–25 g, relaxed low-carb
            up to 50 g.
          </p>
        </div>
      </div>

      {/* About ------------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-title">About</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Tally 0.1.0 — local-first fitness tracker. All your data lives in a
          SQLite database on this device; food photos never leave your phone
          except to the AI model you choose for analysis.
        </p>
      </div>
    </div>
  );
}
