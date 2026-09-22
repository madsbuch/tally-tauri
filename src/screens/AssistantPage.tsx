import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { deleteChat, getSetting, listChats } from "../lib/db";
import { SETTING_KEYS } from "../lib/types";
import type { ChatSummary } from "../lib/types";
import {
  closeAssistantChat,
  getAssistantState,
  openAssistantChat,
  retryAssistant,
  sendAssistantMessage,
  subscribeAssistant,
} from "../lib/assistantRunner";
import type { UiItem } from "../lib/assistantRunner";
import AssistantChart from "../components/AssistantChart";

const SUGGESTIONS = [
  "Chart my sleep for the last two weeks",
  "Calories in vs calories out this week",
  "How is my resting heart rate trending this month?",
  "Am I eating enough protein on training days?",
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
  // The run lives in lib/assistantRunner.ts, so leaving this page (or the app)
  // doesn't touch it — this component only subscribes.
  const state = useSyncExternalStore(subscribeAssistant, getAssistantState);
  const { items, status, error, activeTool, canRetry } = state;
  const busy = status === "running";
  const chatOpen = items.length > 0;

  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void getSetting(SETTING_KEYS.openrouterApiKey).then((k) => setHasKey(!!k));
  }, []);

  useEffect(() => {
    if (!chatOpen) {
      void listChats().then(setHistory).catch(console.error);
    }
  }, [chatOpen]);

  useEffect(() => {
    if (chatOpen) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [items, status, activeTool, chatOpen]);

  async function removeChat(id: number) {
    if (!window.confirm("Delete this chat?")) return;
    await deleteChat(id);
    setHistory(await listChats());
  }

  function send(textRaw?: string) {
    const text = (textRaw ?? input).trim();
    if (!text || busy) return;
    setInput("");
    sendAssistantMessage(text);
  }

  return (
    <div className="page chat-page">
      <header className="page-header">
        <h1 className="page-title">Assistant</h1>
        {chatOpen && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={closeAssistantChat}
            disabled={busy}
          >
            ‹ Chats
          </button>
        )}
      </header>

      {hasKey === false && (
        <div className="card">
          <h2 className="card-title">Set up first</h2>
          <p className="muted small" style={{ margin: 0 }}>
            The assistant needs an OpenRouter API key — add one under Settings →
            OpenRouter, then come back.
          </p>
        </div>
      )}

      {!chatOpen && hasKey !== false && (
        <>
          <p className="muted small" style={{ margin: "0 2px 12px" }}>
            Ask anything about your data — meals, workouts, sleep, heart rate,
            steps, weight, supplements, fasting. The assistant reads your local
            database and can answer with messages and charts.
          </p>
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
                      onClick={() => {
                        void openAssistantChat(c.id).catch((e) =>
                          console.error("Could not open chat", e),
                        );
                      }}
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

      {chatOpen && (
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
          {busy && (
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
          {(status === "error" || status === "interrupted") && error && (
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
          <div ref={endRef} />
        </div>
      )}

      <div className="chat-composer">
        <textarea
          className="input chat-input"
          rows={1}
          placeholder={chatOpen ? "Reply…" : "Ask about your data…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy || hasKey !== true}
        />
        <button
          className="btn btn-primary"
          style={{ flex: "0 0 auto" }}
          onClick={() => send()}
          disabled={busy || !input.trim() || hasKey !== true}
        >
          Send
        </button>
      </div>
    </div>
  );
}
