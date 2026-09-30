import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { deleteChat, getChatMessages, getSetting, listChats } from "../lib/db";
import { SETTING_KEYS } from "../lib/types";
import type { ChatSummary } from "../lib/types";
import {
  closeAssistantChat,
  getAssistantState,
  openAssistantChat,
  retryAssistant,
  sendAssistantMessage,
  startAssistantChat,
  subscribeAssistant,
  transcriptToUi,
} from "../lib/assistantRunner";
import type { UiItem } from "../lib/assistantRunner";
import AssistantChart from "../components/AssistantChart";
import { markCheckinRead, useUnreadCheckin } from "../lib/coachInbox";
import { chatPath, parseChatId, useGo, useUp } from "../lib/navigation";
import InfoButton from "../components/InfoButton";
import { Link } from "../router";

const SUGGESTIONS = [
  "How is my week going?",
  "What should I focus on tomorrow?",
  "Am I eating enough protein on training days?",
  "Chart my sleep for the last two weeks",
];

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

function ActivityRow({ item }: { item: Extract<UiItem, { kind: "activity" }> }) {
  const summary =
    item.tools.length > 0 ? `Checked ${item.tools.join(" · ")}` : "Reasoning";
  if (item.reasoning.length === 0) {
    return <div className="chat-activity chat-activity-static">{summary}</div>;
  }
  return (
    <details className="chat-activity">
      <summary>{summary}</summary>
      <div className="chat-activity-body">
        {item.reasoning.map((r, i) => (
          <p key={i}>{r}</p>
        ))}
      </div>
    </details>
  );
}

export default function AssistantPage() {
  // Which conversation is on screen is the URL's to say: /assistant is the
  // list, /assistant/:chatId one conversation. The run itself lives in
  // lib/assistantRunner.ts, so leaving this page (or the app) doesn't touch
  // it — this component asks it for the chat in the URL and renders that.
  const rawChatId = useParams()["chatId"];
  const inChat = rawChatId !== undefined;
  const chatId = parseChatId(rawChatId);

  const state = useSyncExternalStore(subscribeAssistant, getAssistantState);
  const { status, error, activeTool, canRetry } = state;
  const busy = status === "running";
  const runnerChat = state.chatId;
  // The runner holds this very chat, so its thread, spinner and errors are
  // this page's to show.
  const live = chatId !== null && runnerChat === chatId;

  const go = useGo();
  const up = useUp();
  const unread = useUnreadCheckin();

  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  /** This chat as saved, shown read-only while a turn runs in another one. */
  const [snapshot, setSnapshot] = useState<{ id: number; items: UiItem[] } | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerHeight = useRef(0);

  const items: UiItem[] | null = live
    ? state.items
    : snapshot !== null && snapshot.id === chatId
      ? snapshot.items
      : null;

  useEffect(() => {
    void getSetting(SETTING_KEYS.openrouterApiKey).then((k) => setHasKey(!!k));
  }, []);

  // Load the chat in the URL into the runner. A turn running in another chat
  // keeps the runner until it's done, and this runs again then.
  useEffect(() => {
    if (!inChat) return;
    if (chatId === null) {
      go("/assistant");
      return;
    }
    if (live || busy) return;
    let alive = true;
    openAssistantChat(chatId)
      .then((result) => {
        // Deleted since — a stale notification, say. The list is where it was.
        if (alive && result === "missing") go("/assistant");
      })
      .catch((e) => {
        console.error("Could not open chat", e);
        if (alive) go("/assistant");
      });
    return () => {
      alive = false;
    };
  }, [inChat, chatId, live, busy, go]);

  useEffect(() => {
    if (chatId === null || live || !busy) return;
    let alive = true;
    getChatMessages(chatId)
      .then((saved) => {
        if (!alive) return;
        if (saved) setSnapshot({ id: chatId, items: transcriptToUi(saved) });
        else go("/assistant");
      })
      .catch((e) => console.error("Could not read chat", e));
    return () => {
      alive = false;
    };
  }, [chatId, live, busy, go]);

  // Opening a check-in is reading it, however you got here: the banner, the
  // list, or the notification that announced it.
  useEffect(() => {
    if (chatId !== null) void markCheckinRead(chatId);
  }, [chatId]);

  // Arriving at the list is leaving the conversation that was open, so the
  // Coach tab stops going back to it. A turn still running keeps its chat.
  useEffect(() => {
    if (!inChat) closeAssistantChat();
  }, [inChat]);

  useEffect(() => {
    if (!inChat) {
      void listChats().then(setHistory).catch(console.error);
    }
  }, [inChat, status]);

  useEffect(() => {
    if (inChat) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [items, status, activeTool, inChat]);

  // Grow the box with the message. A textarea doesn't do this on its own — it
  // scrolls inside a fixed height — which makes anything past the first line
  // invisible while you write it. The CSS caps it; past that it scrolls.
  useEffect(() => {
    const field = inputRef.current;
    if (field) {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }
    // The composer is fixed over the thread, so the page's bottom padding has
    // to follow its height or a taller box hides the newest message.
    const composer = composerRef.current;
    if (!composer) return;
    const height = composer.offsetHeight;
    document.documentElement.style.setProperty("--composer-h", `${height}px`);
    if (height !== composerHeight.current) {
      composerHeight.current = height;
      if (inChat) endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [input, inChat]);

  async function removeChat(id: number) {
    if (!window.confirm("Delete this chat?")) return;
    await deleteChat(id);
    setHistory(await listChats());
  }

  function send(textRaw?: string) {
    const text = (textRaw ?? input).trim();
    if (!text || busy || (inChat && !live)) return;
    setInput("");
    if (inChat) {
      sendAssistantMessage(text);
      return;
    }
    // From the list, a new conversation — at its own address.
    void startAssistantChat(text).then((id) => {
      if (id !== null) go(chatPath(id));
      else setInput((current) => current || text);
    });
  }

  return (
    <div className="page chat-page">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Coach
          <InfoButton title="Coach">
            <p>
              It reads the whole diary — meals, workouts, sleep, heart rate,
              steps, weight, supplements, fasting — and remembers what you agree
              on between chats.
            </p>
            <p>
              It also starts conversations of its own when something in the data
              is worth a word. Set what it should push you toward, and when it
              may check in, under Settings → Coach.
            </p>
          </InfoButton>
        </h1>
        {inChat && (
          <button className="btn btn-ghost btn-sm" onClick={up}>
            ‹ Chats
          </button>
        )}
      </header>

      {unread && unread.id !== chatId && (
        <button className="coach-unread" onClick={() => go(chatPath(unread.id))}>
          <span className="coach-unread-icon">🔔</span>
          <span className="coach-unread-main">
            <span className="coach-unread-title">Your coach checked in</span>
            <span className="coach-unread-sub">{unread.title}</span>
          </span>
          <span className="row-end">›</span>
        </button>
      )}

      {hasKey === false && (
        <div className="card">
          <h2 className="card-title">Set up first</h2>
          <p className="muted small" style={{ margin: 0 }}>
            The coach needs an OpenRouter API key — add one under Settings →
            OpenRouter, then come back.
          </p>
        </div>
      )}

      {!inChat && hasKey !== false && (
        <>
          {/* A turn keeps going after you step out of its conversation; this
              is the way back to it. */}
          {busy && runnerChat !== null && (
            <button
              className="list-row chat-suggestion"
              style={{ marginBottom: 12, width: "100%" }}
              onClick={() => go(chatPath(runnerChat))}
            >
              <div className="row-main">
                <div className="row-title">💬 The coach is answering</div>
                <div className="row-sub">
                  {activeTool ? `Checking ${activeTool}…` : "Thinking…"}
                </div>
              </div>
              <div className="row-end">›</div>
            </button>
          )}
          <Link to="/assistant/library" className="list-row" style={{ marginBottom: 12 }}>
            <div className="row-main">
              <div className="row-title">🗄 Library</div>
              <div className="row-sub">
                Blood results and reports the coach can read
              </div>
            </div>
            <div className="row-end">›</div>
          </Link>
          <div className="list">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className="list-row chat-suggestion"
                onClick={() => send(s)}
                disabled={busy || hasKey !== true}
              >
                <div className="row-main">
                  <div className="row-title" style={{ whiteSpace: "normal" }}>
                    {s}
                  </div>
                </div>
                <div className="row-end">→</div>
              </button>
            ))}
          </div>

          {history.length > 0 && (
            <>
              <div className="section-title">Recent chats</div>
              <div className="list">
                {history.map((c) => (
                  <div key={c.id} className="list-row">
                    <button
                      className="chat-suggestion row-main"
                      style={{ background: "none", border: "none", padding: 0 }}
                      onClick={() => go(chatPath(c.id))}
                    >
                      <div className="row-title" style={{ whiteSpace: "normal" }}>
                        {c.title}
                      </div>
                      <div className="row-sub">{relativeTime(c.updated_at)}</div>
                    </button>
                    <button
                      className="btn btn-ghost btn-sm row-end"
                      aria-label="Delete chat"
                      onClick={() => void removeChat(c.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {inChat && items === null && (
        <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
          <span className="spinner" />
        </div>
      )}

      {inChat && items !== null && (
        <div className="chat-thread">
          {items.map((item, i) => {
            if (item.kind === "activity") return <ActivityRow key={i} item={item} />;
            if (item.kind === "chart") {
              return (
                <div key={i} className="chat-msg chat-msg-assistant chat-msg-chart">
                  <div className="chat-bubble">
                    <AssistantChart chart={item.chart} />
                  </div>
                </div>
              );
            }
            const isUser = item.kind === "user";
            return (
              <div
                key={i}
                className={`chat-msg ${isUser ? "chat-msg-user" : "chat-msg-assistant"}`}
              >
                <div className="chat-bubble">
                  {item.kind === "message" ? (
                    <div className="chat-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {item.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    item.text
                  )}
                </div>
              </div>
            );
          })}
          {live && busy && (
            <div className="chat-msg chat-msg-assistant">
              <div className="chat-bubble chat-thinking">
                <div className="spinner" />
                <span className="muted small">
                  {activeTool ? `Checking ${activeTool}…` : "Thinking…"}
                </span>
              </div>
            </div>
          )}
          {/* An interruption is the OS suspending us, not a failure — it says
              so and resumes by itself, but the button is there to force it. */}
          {live && (status === "error" || status === "interrupted") && error && (
            <div
              className={`chat-msg chat-msg-assistant${
                status === "error" ? " chat-msg-error" : ""
              }`}
            >
              <div className="chat-bubble">
                <div>{error}</div>
                {canRetry && (
                  <button
                    className="btn btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={retryAssistant}
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          )}
          {!live && busy && (
            <div className="chat-msg chat-msg-assistant">
              <div className="chat-bubble">
                <div className="muted small">
                  The coach is answering in another conversation — you can reply
                  here once it&apos;s done.
                </div>
                {runnerChat !== null && (
                  <button
                    className="btn btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => go(chatPath(runnerChat))}
                  >
                    Go to it
                  </button>
                )}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="chat-composer" ref={composerRef}>
        <textarea
          ref={inputRef}
          className="input chat-input"
          rows={1}
          enterKeyHint="enter"
          placeholder={inChat ? "Reply…" : "Ask about your data…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter writes a newline. On a phone it's the only line-break key
            // there is and Shift+Enter doesn't exist, so sending on it made
            // paragraphs impossible. Send is the button; Ctrl/Cmd+Enter is
            // there for a hardware keyboard and can't be hit by accident.
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy || hasKey !== true || (inChat && !live)}
        />
        <button
          className="btn btn-primary"
          style={{ flex: "0 0 auto" }}
          onClick={() => send()}
          disabled={busy || !input.trim() || hasKey !== true || (inChat && !live)}
        >
          Send
        </button>
      </div>
    </div>
  );
}
