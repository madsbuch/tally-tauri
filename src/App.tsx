import { useEffect, useState } from "react";
import type { JSX } from "react";
import "./App.css";
import DiaryPage from "./pages/DiaryPage";
import NutrientsPage from "./pages/NutrientsPage";
import FastingPage from "./pages/FastingPage";
import SettingsPage from "./pages/SettingsPage";
import { getDb } from "./lib/db";
import { resyncFastNotification } from "./lib/fasting";
import { resumePendingCaptures } from "./lib/agent";
import { syncHealthConnectWorkouts } from "./lib/healthConnect";

type TabId = "diary" | "nutrients" | "fasting" | "settings";

const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  {
    id: "diary",
    label: "Diary",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    ),
  },
  {
    id: "nutrients",
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
    id: "fasting",
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
    id: "settings",
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
  const [tab, setTab] = useState<TabId>("diary");

  useEffect(() => {
    // Warm the DB (runs migrations), re-sync the fasting notification, resume
    // any captures whose background analysis was interrupted, and pull new
    // Garmin/Health Connect workouts (no-op unless connected in Settings).
    getDb()
      .then(() =>
        Promise.all([
          resyncFastNotification(),
          resumePendingCaptures(),
          syncHealthConnectWorkouts().catch((e) =>
            console.warn("Health Connect sync failed", e),
          ),
        ]),
      )
      .catch((e) => console.error("Startup failed", e));
  }, []);

  return (
    <div className="app">
      <main className="app-main">
        {tab === "diary" && <DiaryPage />}
        {tab === "nutrients" && <NutrientsPage />}
        {tab === "fasting" && <FastingPage />}
        {tab === "settings" && <SettingsPage />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
