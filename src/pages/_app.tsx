import { useEffect, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Link } from "../router";
import type { Path } from "../router";
import { getDb } from "../lib/db";
import { resyncFastNotification } from "../lib/fasting";
import {
  installCaptureLifecycle,
  onDiaryChanged,
  resumePendingCaptures,
} from "../lib/agent";
import { installAppLifecycle } from "../lib/appLifecycle";
import { clearStaleBackgroundTask } from "../lib/background";
import { onAppResume } from "../lib/appLifecycle";
import { runCoachCheckin } from "../lib/coachCheckin";
import { syncCoachSchedule } from "../lib/coachTriggers";
import { cacheCoachPromptPrefix } from "../lib/coach";
import {
  getAssistantState,
  installAssistantLifecycle,
  subscribeAssistant,
} from "../lib/assistantRunner";
import { syncHealthConnect } from "../lib/healthConnect";
import { scanAchievements } from "../lib/achievements";

/** Bottom tab bar — `to` is generouted's typed Path, so a dead link is a type error. */
const TABS: { to: Path; label: string; icon: JSX.Element }[] = [
  {
    to: "/",
    label: "Diary",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    ),
  },
  {
    to: "/nutrients",
    label: "Nutrients",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          d="M20 4c-8.5 0-14 4.5-14 11 0 2.5 1.5 5 4 5 6.5 0 10-5.5 10-16Z"
          strokeLinejoin="round"
        />
        <path d="M6.5 19.5C9 15 12.5 11 17 8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/fasting",
    label: "Fasting",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          d="M6 2.5h12M6 21.5h12M7 2.5c0 5 4 6.5 5 9.5 1-3 5-4.5 5-9.5M7 21.5c0-5 4-6.5 5-9.5 1 3 5 4.5 5 9.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: "/assistant",
    label: "Coach",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          d="M12 3.5c.7 3.8 2.7 5.8 6.5 6.5-3.8.7-5.8 2.7-6.5 6.5-.7-3.8-2.7-5.8-6.5-6.5 3.8-.7 5.8-2.7 6.5-6.5Z"
          strokeLinejoin="round"
        />
        <path
          d="M18.5 14.5c.35 1.9 1.35 2.9 3.25 3.25-1.9.35-2.9 1.35-3.25 3.25-.35-1.9-1.35-2.9-3.25-3.25 1.9-.35 2.9-1.35 3.25-3.25Z"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: "/settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3.2" />
        <path
          d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.8 7.8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5a7.8 7.8 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a7.8 7.8 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.8 7.8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.8 7.8 0 0 0 2.6-1.5l2.4 1 2-3.4Z"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

export default function App() {
  const { pathname } = useLocation();
  // The assistant keeps working after you leave its tab, so say so — otherwise
  // a turn running in the background is invisible.
  const assistantBusy =
    useSyncExternalStore(subscribeAssistant, getAssistantState).status === "running";

  useEffect(() => {
    // Clear a "working…" notification stranded by a previous process before
    // anything new starts holding one.
    void clearStaleBackgroundTask();

    // Warm the DB (runs migrations), re-sync the fasting notification, resume
    // any captures whose background analysis was interrupted, and pull new
    // Garmin/Health Connect data (no-op unless connected in Settings).
    getDb()
      .then(() =>
        Promise.all([
          resyncFastNotification(),
          resumePendingCaptures(),
          syncHealthConnect().catch((e) =>
            console.warn("Health Connect sync failed", e),
          ),
        ]),
      )
      // After sync: fresh Garmin data may complete achievements.
      .then(() => scanAchievements())
      // Fresh data may also be worth a word from the coach. Self-throttling,
      // and a no-op when no trigger fires, so it's safe on every start.
      .then(() => runCoachCheckin())
      // Keep the scheduled check-in armed (alarms don't survive a reinstall)
      // and its prompt prefix current, since it runs with no JS to build one.
      .then(() => Promise.all([syncCoachSchedule(), cacheCoachPromptPrefix()]))
      .catch((e) => console.error("Startup failed", e));

    // Everything that talks to OpenRouter runs outside the pages, so it keeps
    // going across tab switches and survives the OS suspending the app. Track
    // foreground/background transitions once, then let the capture agent and
    // the assistant pick up whatever was interrupted on the way back.
    const offLifecycle = installAppLifecycle();
    const offCaptures = installCaptureLifecycle();
    const offAssistant = installAssistantLifecycle();
    const offCoach = onAppResume(() => void runCoachCheckin());
    return () => {
      offCoach();
      offAssistant();
      offCaptures();
      offLifecycle();
    };
  }, []);

  // Re-scan achievements when diary data changes, debounced — agent captures
  // often log several entries back-to-back.
  useEffect(() => {
    let timer: number | undefined;
    const off = onDiaryChanged(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        scanAchievements().catch(() => {});
      }, 2500);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="app">
      <div className="statusbar-scrim" aria-hidden="true" />
      <main className="app-main">
        <Outlet />
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className={`tab ${pathname === t.to ? "tab-active" : ""}`}
          >
            <span className="tab-icon">
              {t.icon}
              {t.to === "/assistant" && assistantBusy && (
                <span className="tab-dot" aria-label="Assistant is working" />
              )}
            </span>
            <span className="tab-label">{t.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
