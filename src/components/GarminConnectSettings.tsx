import { useEffect, useState } from "react";
import {
  disconnectGarmin,
  garminErrorMessage,
  getGarminLastSync,
  getGarminPausedUntil,
  getGarminStatus,
  loginGarmin,
  setGarminKey,
  submitGarminMfa,
  syncGarmin,
} from "../lib/garmin";
import type { GarminSyncResult } from "../lib/garmin";
import { garminLinkReport } from "../lib/garminDb";
import type { GarminLinkReport } from "../lib/garminDb";
import type { GarminStatus } from "../lib/schemas";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function since(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!isFinite(min) || min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function resultLine(r: GarminSyncResult): string {
  const parts: string[] = [];
  const linked = r.linkedExact + r.linkedByTime;
  if (linked > 0) {
    parts.push(
      `linked ${plural(linked, "activity", "activities")} to existing workouts` +
        ` (${r.linkedExact} exact, ${r.linkedByTime} by time)`,
    );
  }
  if (r.created > 0) parts.push(`added ${plural(r.created, "Garmin-only workout")}`);
  if (r.updated > 0) parts.push(`refreshed ${r.updated}`);
  if (r.laps > 0) parts.push(`laps for ${r.laps}`);
  if (r.days > 0) parts.push(`${plural(r.days, "day")} of wellness`);
  if (r.nights > 0) parts.push(`${plural(r.nights, "night")} Health Connect didn't have`);
  const head = (parts.length ? `Synced: ${parts.join(", ")}.` : "Up to date.") +
    (r.extrasError ? ` Readiness/training status skipped: ${r.extrasError}` : "");
  const tail = r.backfillDone
    ? " History complete."
    : r.wellnessBackTo
      ? ` Wellness history back to ${r.wellnessBackTo} so far. Each sync reaches further.`
      : "";
  return head + tail;
}

/**
 * Settings card for the direct Garmin Connect sync (lib/garmin.ts): the
 * Personal API key (the main way in), the optional unofficial sign-in for
 * training readiness and status, sync, and the linking report — how many
 * activities were attached to existing Health Connect workouts versus added —
 * so the dedup can be checked before it's trusted.
 */
export default function GarminConnectSettings() {
  const [status, setStatus] = useState<GarminStatus | null>(null);
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [pausedUntil, setPausedUntil] = useState<string | null>(null);
  const [report, setReport] = useState<GarminLinkReport | null>(null);

  async function refresh() {
    const [s, at, paused, rep] = await Promise.all([
      getGarminStatus(),
      getGarminLastSync(),
      getGarminPausedUntil(),
      garminLinkReport().catch(() => null),
    ]);
    setStatus(s);
    setLastSync(at);
    setPausedUntil(paused);
    setReport(rep);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(garminErrorMessage(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  const sync = () =>
    run(async () => {
      const r = await syncGarmin({ manual: true });
      setMessage(r ? resultLine(r) : "Nothing to do.");
    });

  const saveKey = () =>
    run(async () => {
      await setGarminKey(key);
      setKey("");
      setMessage("Key accepted. Reading your history. The first sync takes a minute.");
      const r = await syncGarmin({ manual: true });
      if (r) setMessage(resultLine(r));
    });

  const signIn = () =>
    run(async () => {
      const outcome = await loginGarmin(email, password);
      setPassword("");
      if (outcome === "mfa") {
        setStatus((st) => ({ personal: st?.personal ?? false, connected: false, mfaPending: true }));
        setMessage("Garmin sent a verification code. Enter it below.");
        return;
      }
      setMessage("Signed in.");
      const r = await syncGarmin({ manual: true });
      if (r) setMessage(resultLine(r));
    });

  const verify = () =>
    run(async () => {
      await submitGarminMfa(code);
      setCode("");
      setMessage("Signed in.");
      const r = await syncGarmin({ manual: true });
      if (r) setMessage(resultLine(r));
    });

  const removeKey = () => {
    if (!window.confirm("Remove the Garmin personal API key? Everything already synced stays.")) return;
    void run(async () => {
      await disconnectGarmin("key");
      setMessage("Key removed. You can also delete it on Garmin Connect Web.");
    });
  };

  const signOut = () => {
    if (!window.confirm("Sign out of the unofficial Garmin sign-in? Everything already synced stays.")) return;
    void run(async () => {
      await disconnectGarmin("signin");
      setMessage("Signed out.");
    });
  };

  return (
    <div className="card">
      <h2 className="card-title">Garmin Connect (direct)</h2>
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        Pulls what Health Connect doesn’t carry, straight from Garmin: Training
        Effect, training load, HR-zone time, power and laps per activity;
        Body Battery, stress, sleep score and HRV status per day. It attaches
        to the workouts and nights Health Connect already synced instead of
        duplicating them, and fills only the gaps Health Connect left.
      </p>

      {status === null ? (
        <div className="spinner" />
      ) : (
        <>
          {status.personal ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="chip chip-accent">✓ Personal API key</span>
              <button className="btn btn-sm" onClick={() => void sync()} disabled={busy}>
                Sync now
              </button>
              {busy && <div className="spinner" />}
              <button className="btn btn-ghost btn-sm" onClick={removeKey} disabled={busy}>
                Remove key
              </button>
            </div>
          ) : (
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" htmlFor="garmin-key">
                Personal API key
              </label>
              <p className="faint small" style={{ margin: "0 0 6px" }}>
                On Garmin Connect Web: Personal API Key → Create Key, pick how
                long it lasts, and paste it here. Garmin shows it once and
                emails you before it expires. It stays on this device.
              </p>
              <div className="input-row">
                <input
                  id="garmin-key"
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => void saveKey()}
                  disabled={busy || key.trim().length === 0}
                >
                  Save
                </button>
              </div>
              {busy && <div className="spinner" style={{ marginTop: 8 }} />}
            </div>
          )}

          {(status.personal || status.connected) && (
            <p className="faint small" style={{ margin: "10px 0 0" }}>
              Syncs on its own at most every three hours
              {lastSync ? ` · last sync ${since(lastSync)}` : ""}
              {pausedUntil
                ? ` · paused until ${new Date(pausedUntil).toLocaleString()} after Garmin rate-limited us`
                : ""}
              .
            </p>
          )}

          <details style={{ marginTop: 12 }} open={status.connected || status.mfaPending}>
            <summary className="small" style={{ cursor: "pointer", fontWeight: 600 }}>
              Training readiness &amp; status (optional, unofficial)
            </summary>
            <p className="faint small" style={{ margin: "6px 0 8px" }}>
              The Personal API doesn’t serve training readiness or training
              status. Signing in the way the Garmin Connect app does adds them
              for recent days. Unofficial: your password goes to Garmin once and
              is never stored, and it will stop working now and then when Garmin
              changes its sign-in.
            </p>
            {status.connected ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="chip chip-accent">✓ Signed in</span>
                {!status.personal && (
                  <button className="btn btn-sm" onClick={() => void sync()} disabled={busy}>
                    Sync now
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={signOut} disabled={busy}>
                  Sign out
                </button>
              </div>
            ) : status.mfaPending ? (
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="garmin-mfa">
                  Verification code
                </label>
                <div className="input-row">
                  <input
                    id="garmin-mfa"
                    className="input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => void verify()}
                    disabled={busy || code.trim().length === 0}
                  >
                    Verify
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <input
                  className="input"
                  type="email"
                  autoComplete="username"
                  placeholder="Garmin email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <div>
                  <button
                    className="btn btn-sm"
                    onClick={() => void signIn()}
                    disabled={busy || !email.trim() || !password}
                  >
                    Sign in to Garmin
                  </button>
                </div>
              </div>
            )}
          </details>
        </>
      )}

      {report && report.activities > 0 && (
        <div className="muted small" style={{ marginTop: 10, display: "grid", gap: 2 }}>
          <div>
            {plural(report.activities, "Garmin activity", "Garmin activities")}:{" "}
            {report.exact + report.time} attached to existing workouts ({report.exact} exact,{" "}
            {report.time} by time), {report.created} Garmin-only
            {report.dismissed > 0 ? `, ${report.dismissed} you deleted` : ""}.
          </div>
          {report.days > 0 && (
            <div>
              {plural(report.days, "day")} of wellness
              {report.earliestDay ? `, back to ${report.earliestDay}` : ""}.
            </div>
          )}
        </div>
      )}
      {report && (
        <p className="faint small" style={{ margin: "6px 0 0", wordBreak: "break-all" }}>
          Health Connect record ids:{" "}
          {report.hcWithRecordId > 0
            ? `${report.hcWithRecordId} workouts carry one, e.g. “${report.hcRecordIdExample}”.`
            : "none seen yet (they're read from the next Health Connect sync on)."}
        </p>
      )}

      {message && (
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          {message}
        </p>
      )}
      {error && (
        <div className="error-text" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
