import { useEffect, useMemo, useState } from "react";
import { aiSpendSince, deleteSetting, getSetting, setSetting, todayStr } from "../lib/db";
import type { AiSpend } from "../lib/db";
import { shiftDay } from "../lib/daystamp";
import { supportsTools } from "../lib/openrouter";
import { parseJson, parseModelList } from "../lib/schemas";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import type { ORModel } from "../lib/types";
import {
  COACH_REASONING_OPTIONS,
  formatUsd,
  parseBudget,
  parseCoachReasoning,
} from "../lib/coachModel";
import type { CoachReasoning } from "../lib/coachModel";
import ModelRow, { modelSub } from "./ModelRow";

const MAX_LIST_ROWS = 30;

interface Spend {
  today: AiSpend;
  week: AiSpend;
  month: AiSpend;
}

/** Share of prompt tokens that came from the cache, as "62%". */
function cachedShare(s: AiSpend): string | null {
  if (s.promptTokens === 0) return null;
  return `${Math.round((100 * s.cachedTokens) / s.promptTokens)}%`;
}

/**
 * A model picker for one coach setting. "" means "use the fallback", which
 * is shown as its own first row so there's always a way back to it.
 */
function CoachModelPicker({
  label,
  hint,
  value,
  fallbackLabel,
  models,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  fallbackLabel: string;
  models: ORModel[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const info = value ? (models.find((m) => m.id === value) ?? null) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [models, search]);
  const shown = filtered.slice(0, MAX_LIST_ROWS);

  function pick(id: string) {
    setOpen(false);
    setSearch("");
    onChange(id);
  }

  return (
    <div className="field">
      <label className="label">{label}</label>
      <div className="list-row" style={{ background: "var(--bg-elev)", marginBottom: 6 }}>
        <div className="row-main">
          <div className="row-title">{value ? (info?.name ?? value) : fallbackLabel}</div>
          <div className="row-sub">
            {value ? (info ? modelSub(info) : "Not in cached list") : hint}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ flex: "0 0 auto" }}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Done" : "Change"}
        </button>
      </div>
      {open && (
        <>
          <input
            className="input"
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ marginBottom: 8 }}
          />
          <div className="list">
            {!search.trim() && (
              <button
                className="list-row"
                onClick={() => pick("")}
                style={{
                  font: "inherit",
                  color: "inherit",
                  textAlign: "left",
                  width: "100%",
                  cursor: "pointer",
                  ...(value === "" ? { borderColor: "var(--accent)" } : {}),
                }}
              >
                <div className="row-main">
                  <div className="row-title">{fallbackLabel}</div>
                </div>
              </button>
            )}
            {models.length === 0 ? (
              <div className="empty">
                No models cached yet. Tap “Refresh models” under Vision model.
              </div>
            ) : (
              shown.map((m) => (
                <ModelRow key={m.id} model={m} selected={m.id === value} onSelect={pick} />
              ))
            )}
            {filtered.length > shown.length && (
              <div className="faint small" style={{ textAlign: "center", padding: "6px 0" }}>
                …and {filtered.length - shown.length} more. Refine your search
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * What the coach costs, and the settings that decide it: which model it
 * chats and checks in on, how hard it thinks, and a daily cap on check-ins.
 */
export default function CoachCostSettings() {
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<ORModel[]>([]);
  const [visionModel, setVisionModel] = useState(DEFAULT_VISION_MODEL);
  const [coachModel, setCoachModel] = useState("");
  const [checkinModel, setCheckinModel] = useState("");
  const [reasoning, setReasoning] = useState<CoachReasoning>("");
  const [budget, setBudget] = useState("");
  const [spend, setSpend] = useState<Spend | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const today = todayStr();
      const [cache, vision, coach, checkin, effort, cap, todaySpend, week, month] =
        await Promise.all([
          getSetting(SETTING_KEYS.modelsCache),
          getSetting(SETTING_KEYS.visionModel),
          getSetting(SETTING_KEYS.coachModel),
          getSetting(SETTING_KEYS.checkinModel),
          getSetting(SETTING_KEYS.coachReasoning),
          getSetting(SETTING_KEYS.checkinDailyBudget),
          aiSpendSince(today),
          aiSpendSince(shiftDay(today, -6)),
          aiSpendSince(shiftDay(today, -29)),
        ]).catch(() => [null, null, null, null, null, null, null, null, null] as const);
      if (!alive) return;
      let list: ORModel[] = [];
      if (cache) {
        try {
          list = parseModelList(parseJson(cache)) ?? [];
        } catch {
          list = [];
        }
      }
      // Text and tools is all the coach needs; cheapest first, since that's
      // the point of picking one here.
      const usable = list.filter(supportsTools);
      usable.sort(
        (a, b) =>
          parseFloat(a.pricing?.prompt ?? "Infinity") - parseFloat(b.pricing?.prompt ?? "Infinity"),
      );
      setModels(usable);
      setVisionModel(vision || DEFAULT_VISION_MODEL);
      setCoachModel(coach ?? "");
      setCheckinModel(checkin ?? "");
      setReasoning(parseCoachReasoning(effort));
      setBudget(cap ?? "");
      if (todaySpend && week && month) setSpend({ today: todaySpend, week, month });
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  function save(key: string, value: string) {
    void (value ? setSetting(key, value) : deleteSetting(key)).catch((e: unknown) =>
      console.warn("Could not save coach setting", e),
    );
  }

  function commitBudget() {
    const n = parseBudget(budget);
    const str = n == null ? "" : String(n);
    setBudget(str);
    save(SETTING_KEYS.checkinDailyBudget, str);
  }

  if (!loaded) return null;

  const coachName = models.find((m) => m.id === coachModel)?.name ?? coachModel;

  return (
    <>
      <div className="card">
        <h2 className="card-title">What it costs</h2>
        {spend && spend.month.requests > 0 ? (
          <>
            <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
              <div>
                <div className="faint small">Today</div>
                <strong>{formatUsd(spend.today.costUsd)}</strong>
              </div>
              <div>
                <div className="faint small">7 days</div>
                <strong>{formatUsd(spend.week.costUsd)}</strong>
              </div>
              <div>
                <div className="faint small">30 days</div>
                <strong>{formatUsd(spend.month.costUsd)}</strong>
              </div>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {spend.month.requests} requests in 30 days
              {cachedShare(spend.month)
                ? `, ${cachedShare(spend.month)} of what they sent read from the cache at a discount`
                : ""}
              . Chats and check-ins as OpenRouter billed them; photo analysis isn&apos;t
              counted here.
            </p>
          </>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            Nothing logged yet. What each chat and check-in costs shows up here from
            now on.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Coach model</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          The coach only reads text, so it doesn&apos;t need a vision model. Every
          model listed can use tools; cheapest first.
        </p>
        <CoachModelPicker
          label="Chats"
          hint={visionModel}
          value={coachModel}
          fallbackLabel="Same as the vision model"
          models={models}
          onChange={(id) => {
            setCoachModel(id);
            save(SETTING_KEYS.coachModel, id);
          }}
        />
        <CoachModelPicker
          label="Check-ins"
          hint={coachModel || visionModel}
          value={checkinModel}
          fallbackLabel={coachModel ? `Same as chats (${coachName})` : "Same as chats"}
          models={models}
          onChange={(id) => {
            setCheckinModel(id);
            save(SETTING_KEYS.checkinModel, id);
          }}
        />
        <div className="field">
          <label className="label">Thinking</label>
          <div className="seg">
            {COACH_REASONING_OPTIONS.map((o) => (
              <button
                key={o.value || "default"}
                className={`seg-item${reasoning === o.value ? " seg-item-active" : ""}`}
                onClick={() => {
                  setReasoning(o.value);
                  save(SETTING_KEYS.coachReasoning, o.value);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="faint small" style={{ margin: "6px 0 0" }}>
            For models that think before answering. Thinking is billed as output, so
            less of it costs less; models that don&apos;t think ignore this.
          </p>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="checkin-budget">
            Check-in cap per day (USD)
          </label>
          <input
            id="checkin-budget"
            className="input"
            inputMode="decimal"
            placeholder="No cap"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={commitBudget}
          />
          <p className="faint small" style={{ margin: "6px 0 0" }}>
            Once check-ins have spent this much today, the coach stays quiet until
            tomorrow. Asking for one in Settings ignores the cap.
          </p>
        </div>
      </div>
    </>
  );
}
