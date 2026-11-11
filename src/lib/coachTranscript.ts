/**
 * Keeping a coach transcript cheap to resend.
 *
 * Every request sends the whole conversation, so what sits in it is paid for
 * again on every step of every later turn. Two kinds of message get stale:
 * the context note the app puts before each user message, and tool results a
 * turn already answered from. Both are shortened once their turn is over.
 *
 * Kept free of app imports so it can be tested on its own.
 */
import type { ChatMessage } from "./schemas";

/**
 * Marks the context note the app puts before each user message. It's sent as
 * a user message because that's the one role every provider accepts mid-
 * conversation, so it has to be told apart from what they actually wrote.
 */
export const COACH_CONTEXT_MARK = "[Tally context]";

/** True for a context note, which isn't something they wrote. */
export function isCoachContext(m: ChatMessage): boolean {
  return (
    m.role === "user" &&
    typeof m.content === "string" &&
    m.content.startsWith(COACH_CONTEXT_MARK)
  );
}

/** Index of the last message they wrote themselves; -1 when there is none. */
export function lastUserIndexOf(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && !isCoachContext(m)) return i;
  }
  return -1;
}

/** Tool results this short are kept as they are. */
export const KEEP_RESULT_CHARS = 600;

/**
 * Results worth keeping in full: the schema is reference the model would only
 * fetch again, and kept, it is read from the cache at a fraction of the price.
 */
const KEEP_RESULTS_OF = new Set(["describe_database"]);

export const STALE_CONTEXT = `${COACH_CONTEXT_MARK} Earlier snapshot, superseded by the newest note.`;

/**
 * Shorten what earlier turns already used: tool results and context notes
 * from before the message being answered (the note right before it is the
 * live one and stays).
 *
 * A shortened message is short enough to be left alone the next time round,
 * so earlier turns change once and then stay put, and the provider's cache
 * keeps covering them.
 */
export function compactTranscript(messages: ChatMessage[]): ChatMessage[] {
  const end = lastUserIndexOf(messages);
  if (end < 0) return messages;
  const prev = messages[end - 1];
  const liveNote = prev && isCoachContext(prev) ? end - 1 : -1;
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) toolNames.set(c.id, c.function.name);
  }
  return messages.map((m, i) => {
    if (i >= end || i === liveNote) return m;
    if (isCoachContext(m)) {
      return m.content === STALE_CONTEXT ? m : { ...m, content: STALE_CONTEXT };
    }
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    if (m.content.length <= KEEP_RESULT_CHARS) return m;
    const name = (m.tool_call_id && toolNames.get(m.tool_call_id)) || "tool";
    if (KEEP_RESULTS_OF.has(name)) return m;
    return {
      ...m,
      content: `[${name} result from an earlier turn, ${m.content.length} characters, removed after it was used. Call ${name} again if you need it.]`,
    };
  });
}
