import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getSetting } from "../lib/db";
import { SETTING_KEYS } from "../lib/types";
import { buildAssistantSystemPrompt, runAssistantTurn } from "../lib/assistant";
import type { ChatMessage } from "../lib/openrouter";

interface UiMessage {
  role: "user" | "assistant";
  text: string;
  /** Friendly labels of the tools used for this reply. */
  tools?: string[];
  error?: boolean;
}

// Module-level so the conversation survives tab switches (the page unmounts).
let cachedUi: UiMessage[] = [];
let cachedTranscript: ChatMessage[] = [];

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
  "How did I sleep this past week?",
  "Summarize my training load for the last 14 days",
  "Am I eating enough protein on training days?",
  "How is my resting heart rate trending this month?",
];

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<UiMessage[]>(cachedUi);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void getSetting(SETTING_KEYS.openrouterApiKey).then((k) => setHasKey(!!k));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy, activeTool]);

  function pushUi(msg: UiMessage) {
    cachedUi = [...cachedUi, msg];
    setMessages(cachedUi);
  }

  function newChat() {
    cachedUi = [];
    cachedTranscript = [];
    setMessages([]);
  }

  async function send(textRaw?: string) {
    const text = (textRaw ?? input).trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setActiveTool(null);
    pushUi({ role: "user", text });

    // The system prompt carries the current time — refresh it every turn.
    const system: ChatMessage = { role: "system", content: buildAssistantSystemPrompt() };
    if (cachedTranscript.length === 0) {
      cachedTranscript.push(system);
    } else {
      cachedTranscript[0] = system;
    }
    cachedTranscript.push({ role: "user", content: text });

    try {
      const { reply, toolsUsed } = await runAssistantTurn(cachedTranscript, (name) =>
        setActiveTool(toolLabel(name)),
      );
      pushUi({ role: "assistant", text: reply, tools: toolsUsed.map(toolLabel) });
    } catch (e) {
      pushUi({
        role: "assistant",
        text: e instanceof Error ? e.message : String(e),
        error: true,
      });
    } finally {
      setBusy(false);
      setActiveTool(null);
    }
  }

  return (
    <div className="page chat-page">
      <header className="page-header">
        <h1 className="page-title">Assistant</h1>
        {messages.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={newChat} disabled={busy}>
            New chat
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

      {messages.length === 0 && hasKey !== false && (
        <>
          <p className="muted small" style={{ margin: "0 2px 12px" }}>
            Ask anything about your data — meals, workouts, sleep, heart rate,
            steps, weight, supplements, fasting. The assistant reads your local
            database with tools and answers from what it finds.
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
        </>
      )}

      <div className="chat-thread">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`chat-msg ${m.role === "user" ? "chat-msg-user" : "chat-msg-assistant"} ${
              m.error ? "chat-msg-error" : ""
            }`}
          >
            <div className="chat-bubble">
              {m.role === "assistant" && !m.error ? (
                <div className="chat-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                </div>
              ) : (
                m.text
              )}
            </div>
            {m.tools && m.tools.length > 0 && (
              <div className="chat-tools faint small">Checked: {m.tools.join(" · ")}</div>
            )}
          </div>
        ))}
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

      <div className="chat-composer">
        <textarea
          className="input chat-input"
          rows={1}
          placeholder="Ask about your data…"
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
