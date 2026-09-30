import { useEffect, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { getDb } from "../lib/db";
import { resyncFastNotification } from "../lib/fasting";
import {
  installCaptureLifecycle,
  onDiaryChanged,
  resumePendingCaptures,
} from "../lib/agent";
import { installAppLifecycle, onAppResume } from "../lib/appLifecycle";
import { clearStaleBackgroundTask } from "../lib/background";
import { installDocumentLifecycle, resumePendingDocuments } from "../lib/documents";
import { runCoachCheckin } from "../lib/coachCheckin";
import { syncCoachSchedule } from "../lib/coachTriggers";
import { cacheCoachPromptPrefix } from "../lib/coach";
import {
  closeAssistantChat,
  getAssistantState,
  installAssistantLifecycle,
  subscribeAssistant,
} from "../lib/assistantRunner";
import {
  onCheckinTapped,
  takeOpenedCheckin,
  tookCheckinThisVisit,
  useUnreadCheckin,
} from "../lib/coachInbox";
import { STALE_CHAT_MS, chatIdOf, chatPath, tabOf, useGo } from "../lib/navigation";
import type { TabRoot } from "../lib/navigation";
import { syncHealthConnect } from "../lib/healthConnect";
import { scanAchievements } from "../lib/achievements";
import AchievementToast from "../components/AchievementToast";

/**
 * Bottom tab bar. `to` is one of the tab roots in lib/navigation.ts, which are
 * checked against generouted's typed Path, so a dead link is a type error.
 *
 * A tab bar is not a trail: pushing meant that after a few minutes of moving
 * between tabs, leaving the app took a dozen presses of back, replaying every
 * tab you had looked at. So a tab goes through `go`, which unwinds to the
 * bottom of the history and puts the tab there — back from a tab leaves the
 * app, even when you left from one of another tab's pages.
 */
const TABS: { to: TabRoot; label: string; icon: JSX.Element }[] = [
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
  const currentTab = tabOf(pathname);
  const go = useGo();
  const assistant = useSyncExternalStore(subscribeAssistant, getAssistantState);
  // The assistant keeps working after you leave its tab, so say so — otherwise
  // a turn running in the background is invisible.
  const assistantBusy = assistant.status === "running";
  // A check-in the user hasn't opened: findable from any tab, for when its
  // notification was swiped away or never seen.
  const unreadCheckin = useUnreadCheckin();

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
          resumePendingDocuments(),
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
    const offDocuments = installDocumentLifecycle();
    const offCoach = onAppResume(() => void runCoachCheckin());
    // A running fast crosses its 16/24/48h marks while the app sits in the
    // background, with no diary change to notice it — check on the way back.
    const offScan = onAppResume(() => void scanAchievements().catch(() => {}));
    return () => {
      offScan();
      offCoach();
      offDocuments();
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

  // A check-in notification was tapped: go straight to its conversation.
  // Asked at launch (the tap that started the app), on every return (the tap
  // that brought it back) and when the plugin says so (a tap while the app was
  // already in front). Each tap is handed out once, so asking again is safe.
  useEffect(() => {
    const follow = async (): Promise<void> => {
      const chatId = await takeOpenedCheckin();
      if (chatId !== null) go(chatPath(chatId));
    };
    void follow();
    const offTap = onCheckinTapped(() => void follow());
    const offResume = onAppResume((awayMs) => {
      void follow().then(() => {
        if (awayMs < STALE_CHAT_MS) return;
        // A return fires this twice (visibility, then focus), and the tap
        // that caused it can be taken by either call or by the plugin's event
        // before both. Whichever took it, a tap since coming back is where
        // you are — not something to tidy away.
        if (tookCheckinThisVisit()) return;
        // Long enough away that the open conversation isn't where you are
        // any more. Nothing is lost: the transcript is saved after every turn
        // and the chat stays at the top of the list.
        if (getAssistantState().status !== "idle") return;
        if (chatIdOf(window.location.pathname) !== null) go("/assistant");
        else closeAssistantChat();
      });
    });
    return () => {
      offTap();
      offResume();
    };
  }, [go]);

  return (
    <div className="app">
      <div className="statusbar-scrim" aria-hidden="true" />
      <main className="app-main">
        <Outlet />
      </main>
      <nav className="tabbar">
        {TABS.map((t) => {
          // The Coach tab goes back to the conversation you left open. The
          // tab you're already in goes back to its top.
          const to =
            t.to === "/assistant" && currentTab !== t.to && assistant.chatId !== null
              ? chatPath(assistant.chatId)
              : t.to;
          return (
            <Link
              key={t.to}
              to={to}
              onClick={(e) => {
                e.preventDefault();
                go(to);
              }}
              className={`tab ${currentTab === t.to ? "tab-active" : ""}`}
            >
              <span className="tab-icon">
                {t.icon}
                {t.to === "/assistant" && (assistantBusy || unreadCheckin) && (
                  <span
                    className={`tab-dot${assistantBusy ? "" : " tab-dot-unread"}`}
                    aria-label={
                      assistantBusy ? "Coach is working" : "Your coach checked in"
                    }
                  />
                )}
              </span>
              <span className="tab-label">{t.label}</span>
            </Link>
          );
        })}
      </nav>
      <AchievementToast />
    </div>
  );
}
