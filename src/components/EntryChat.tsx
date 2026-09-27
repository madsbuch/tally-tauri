/**
 * The thread on an entry.
 *
 * This started life as a box called "Correct it", which did one thing: you
 * told it what was wrong and it re-estimated. But half of what people want to
 * say to an estimate isn't a correction at all — "why is that so high?", "is
 * that plausible for a bowl that size?", "what is that number even made of?" —
 * and a box that answers every sentence by rewriting the entry can't be asked
 * a question. So it's a conversation now, kept per entry: ask and nothing
 * moves, correct and the numbers follow, and either way the exchange stays on
 * the page with the change it made printed under it.
 */
import { useCallback, useEffect, useState } from "react";
import { listEntryMessages } from "../lib/db";
import { sendEntryMessage, undoEntryChange } from "../lib/entryChat";
import InfoButton from "./InfoButton";
import { errMsg } from "./EntryBits";
import type { EntryMessage, FoodEntry, Workout } from "../lib/types";

const PLACEHOLDER = "Ask about it, or correct it";

/** One exchange: the bubble, and what it did to the entry. */
function Message({ msg }: { msg: EntryMessage }) {
  return (
    <div className={`chat-msg chat-msg-${msg.role}`}>
      <div className="chat-bubble">{msg.text}</div>
      {msg.changes.length > 0 && (
        <ul className="chat-changes">
          {msg.changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EntryChat({
  entry,
  onChanged,
}: {
  entry: FoodEntry | Workout;
  /** Something in the entry moved — the page should re-read it. */
  onChanged: () => void;
}) {
  const kind = "eaten_at" in entry ? "meal" : "workout";
  const entryId = entry.id;

  const [messages, setMessages] = useState<EntryMessage[]>([]);
  const [text, setText] = useState("");
  /** The message in flight, shown as its own bubble while we wait. */
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMessages(await listEntryMessages(kind, entryId));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [kind, entryId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    setText("");
    setPending(message);
    setBusy(true);
    setError(null);
    try {
      const { changes } = await sendEntryMessage(entry, message);
      await load();
      if (changes.length > 0) onChanged();
    } catch (e) {
      setError(errMsg(e));
      // Nothing was written, so give them their words back rather than make
      // them type the question again.
      setText((t) => t || message);
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function undo(before: FoodEntry | Workout) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await undoEntryChange(entry, before);
      await load();
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  // Undo belongs to the most recent change, not the most recent message:
  // asking a follow-up question shouldn't cost you the ability to take a
  // correction back. A newer change replaces it, and an undo — which carries
  // no snapshot of its own — ends the chain rather than starting a loop.
  const lastChange = messages.filter((m) => m.changes.length > 0).pop();
  const undoable = lastChange?.before ?? null;

  return (
    <div className="entry-chat">
      <div className="section-title entry-chat-title">
        Ask about it
        <InfoButton title="Asking about an entry">
          <p>
            Two things happen here. Ask a question — &quot;why is that so
            high?&quot;, &quot;does that include the oil?&quot; — and you get an
            answer; the entry doesn&apos;t move.
          </p>
          <p>
            Tell it something new — &quot;the cheese block was 7 g, not 3 g&quot;
            — and it re-estimates the whole entry around that, because a portion
            change moves every nutrient with it. What it changed is listed under
            the reply, and the last change can be undone.
          </p>
          <p>
            The conversation stays on this entry, so months later you can still
            see which sentence set which number.
          </p>
        </InfoButton>
      </div>

      {messages.length === 0 && !pending && (
        <p className="muted small chat-empty">
          Nothing asked yet. These numbers are an estimate — ask what they
          assume, or say what was actually on the plate.
        </p>
      )}

      {(messages.length > 0 || pending) && (
        <div className="chat-thread">
          {messages.map((m) => (
            <Message key={m.id} msg={m} />
          ))}
          {pending && (
            <>
              <div className="chat-msg chat-msg-user">
                <div className="chat-bubble">{pending}</div>
              </div>
              <div className="chat-msg chat-msg-assistant">
                <div className="chat-bubble">
                  <span className="spinner" />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {undoable && !pending && (
        <button
          className="btn btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => void undo(undoable)}
          disabled={busy}
        >
          Undo that change
        </button>
      )}

      {error && (
        <div className="error-text" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <textarea
        className="input entry-chat-input"
        rows={2}
        style={{ marginTop: 12 }}
        placeholder={PLACEHOLDER}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter is a line break on a phone; send is the button.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button
          className="btn btn-primary btn-block"
          onClick={() => void send()}
          disabled={busy || !text.trim()}
        >
          {busy ? <span className="spinner" /> : "Send"}
        </button>
      </div>
    </div>
  );
}
