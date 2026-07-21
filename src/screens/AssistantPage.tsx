import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createChat,
  deleteChat,
  getChatMessages,
  getSetting,
  listChats,
  updateChatMessages,
} from "../lib/db";
import { SETTING_KEYS } from "../lib/types";
import type { ChatSummary } from "../lib/types";
import {
  buildAssistantSystemPrompt,
  runAssistantTurn,
  sanitizeChart,
} from "../lib/assistant";
import type { AssistantEvent, ChartSpec } from "../lib/assistant";
import type { ChatMessage } from "../lib/openrouter";
import { parseToolArgs } from "../lib/schemas";
import AssistantChart from "../components/AssistantChart";

/**
 * The visible thread. `message`/`chart` are what the agent delivered;
 * `activity` is the collapsed reasoning thread (tool calls + private text)
 * that produced them.
 */
type UiItem =
  | { kind: "user"; text: string }
  | { kind: "message"; text: string }
  | { kind: "chart"; chart: ChartSpec }
  | { kind: "activity"; reasoning: string[]; tools: string[] }
  | { kind: "error"; text: string };

// Module-level so the open conversation survives tab switches (the page
// unmounts). The transcript itself is persisted to the `chats` table.
let cachedUi: UiItem[] = [];
let cachedTranscript: ChatMessage[] = [];
let cachedChatId: number | null = null;

const TOOL_LABELS: Record<string, string> = {
  query_meals: "meals",
  query_workouts: "workouts",
  query_sleep: "sleep",
  query_health_metrics: "health metrics",
  query_supplements: "supplements",
  query_fasts: "fasts",
  run_sql: "database",
};

const SUGGESTIONS = [
  "Chart my sleep for the last two weeks",
  "Calories in vs calories out this week",
  "How is my resting heart rate trending this month?",
  "Am I eating enough protein on training days?",
];

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** Chat title = the first user message, trimmed to a row-friendly length. */
function chatTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= 60 ? t : `${t.slice(0, 57)}…`;
}

/** Merge an event into the thread, folding reasoning/tools into activity rows. */
function appendEvent(items: UiItem[], e: AssistantEvent): UiItem[] {
  const last = items[items.length - 1];
  if (e.type === "tool" || e.type === "reasoning") {
    const label = e.type === "tool" ? toolLabel(e.name) : null;
    if (last?.kind === "activity") {
      const updated: UiItem = {
        kind: "activity",
        reasoning: e.type === "reasoning" ? [...last.reasoning, e.text] : last.reasoning,
        tools:
          label && !last.tools.includes(label) ? [...last.tools, label] : last.tools,
      };
      return [...items.slice(0, -1), updated];
    }
    return [
      ...items,
      {
        kind: "activity",
        reasoning: e.type === "reasoning" ? [e.text] : [],
        tools: label ? [label] : [],
      },
    ];
  }
  if (e.type === "message") return [...items, { kind: "message", text: e.text }];
  return [...items, { kind: "chart", chart: e.chart }];
}

/**
 * Rebuild the visible thread from a stored transcript: user messages, the
 * send_message/send_chart deliveries, and everything else as activity rows.
 */
function transcriptToUi(messages: ChatMessage[]): UiItem[] {
  let items: UiItem[] = [];
  let deliveredSinceUser = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user" && typeof m.content === "string") {
      items.push({ kind: "user", text: m.content });
      deliveredSinceUser = false;
      continue;
    }
    if (m.role !== "assistant") continue;
    const content = typeof m.content === "string" ? m.content.trim() : "";
    const calls = m.tool_calls ?? [];
    if (content) {
      // Prose on a final assistant message with nothing delivered was shown
      // to the user directly; everything else was private reasoning.
      const wasFallbackReply = calls.length === 0 && !deliveredSinceUser;
      items = appendEvent(
        items,
        wasFallbackReply
          ? { type: "message", text: content }
          : { type: "reasoning", text: content },
      );
      if (wasFallbackReply) deliveredSinceUser = true;
    }
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = parseToolArgs(call.function.arguments);
      } catch {
        // Malformed args — surfaced to the model at runtime; skip in replay.
      }
      if (call.function.name === "send_message") {
        if (typeof args["text"] === "string" && args["text"].trim()) {
          items = appendEvent(items, { type: "message", text: args["text"].trim() });
          deliveredSinceUser = true;
        }
      } else if (call.function.name === "send_chart") {
        try {
          items = appendEvent(items, { type: "chart", chart: sanitizeChart(args) });
          deliveredSinceUser = true;
        } catch {
          // The chart was rejected at runtime too — nothing was shown.
        }
      } else {
        items = appendEvent(items, { type: "tool", name: call.function.name });
      }
    }
  }
  return items;
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
  const [items, setItems] = useState<UiItem[]>(cachedUi);
  const [chatOpen, setChatOpen] = useState(cachedUi.length > 0);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
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
  }, [items, busy, activeTool, chatOpen]);

  function pushItem(item: UiItem) {
    cachedUi = [...cachedUi, item];
    setItems(cachedUi);
  }

  /** Back to the landing (history + suggestions). The chat is already saved. */
  function closeChat() {
    cachedUi = [];
    cachedTranscript = [];
    cachedChatId = null;
    setItems([]);
    setChatOpen(false);
  }

  async function openChat(id: number) {
    try {
      const transcript = await getChatMessages(id);
      if (!transcript) return;
      cachedTranscript = transcript;
      cachedUi = transcriptToUi(transcript);
      cachedChatId = id;
      setItems(cachedUi);
      setChatOpen(true);
    } catch (e) {
      console.error("Could not open chat", e);
    }
  }

  async function removeChat(id: number) {
    if (!window.confirm("Delete this chat?")) return;
    await deleteChat(id);
    setHistory(await listChats());
  }

  async function persistTranscript() {
    try {
      if (cachedChatId == null) {
        const firstUser = cachedTranscript.find(
          (m) => m.role === "user" && typeof m.content === "string",
        );
        const title = chatTitle(
          typeof firstUser?.content === "string" ? firstUser.content : "Chat",
        );
        cachedChatId = await createChat(title, cachedTranscript);
      } else {
        await updateChatMessages(cachedChatId, cachedTranscript);
      }
    } catch (e) {
      console.error("Could not save chat", e);
    }
  }

  async function send(textRaw?: string) {
    const text = (textRaw ?? input).trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setActiveTool(null);
    setChatOpen(true);
    pushItem({ kind: "user", text });

    // The system prompt carries the current time — refresh it every turn.
    const system: ChatMessage = { role: "system", content: buildAssistantSystemPrompt() };
    if (cachedTranscript.length === 0) {
      cachedTranscript.push(system);
    } else {
      cachedTranscript[0] = system;
    }
    cachedTranscript.push({ role: "user", content: text });

    try {
      await runAssistantTurn(cachedTranscript, (e) => {
        if (e.type === "tool") setActiveTool(toolLabel(e.name));
        else if (e.type === "message" || e.type === "chart") setActiveTool(null);
        cachedUi = appendEvent(cachedUi, e);
        setItems(cachedUi);
      });
    } catch (e) {
      pushItem({
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      await persistTranscript();
      setBusy(false);
      setActiveTool(null);
    }
  }

  return (
    <div className="page chat-page">
      <header className="page-header">
        <h1 className="page-title">Assistant</h1>
        {chatOpen && (
          <button className="btn btn-ghost btn-sm" onClick={closeChat} disabled={busy}>
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
                onClick={() => void send(s)}
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
                      onClick={() => void openChat(c.id)}
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
                className={`chat-msg ${isUser ? "chat-msg-user" : "chat-msg-assistant"} ${
                  item.kind === "error" ? "chat-msg-error" : ""
                }`}
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
              void send();
            }
          }}
          disabled={busy || hasKey !== true}
        />
        <button
          className="btn btn-primary"
          style={{ flex: "0 0 auto" }}
          onClick={() => void send()}
          disabled={busy || !input.trim() || hasKey !== true}
        >
          Send
        </button>
      </div>
    </div>
  );
}
