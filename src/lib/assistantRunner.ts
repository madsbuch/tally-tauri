/**
 * The assistant conversation, driven outside React.
 *
 * A turn used to run inside the Assistant page's `send()`. Leaving the page
 * (or the tab bar, or the app) therefore lost the spinner, let a second turn
 * start on top of the first, and turned an OS-suspended request into a dead
 * red bubble with no way back.
 *
 * So the run lives here instead: one module-level state machine that owns the
 * transcript, keeps going while no page is mounted, writes progress to the
 * `chats` table after every round, and exposes an explicit retry. The page
 * only subscribes and renders.
 *
 * Suspension is not failure: if the app was backgrounded during a round (see
 * lib/appLifecycle.ts) the turn parks as "interrupted" and resumes by itself
 * when the app comes back, instead of reporting an error the user has to
 * clear by hand.
 */
import {
  createChat,
  getChatMessages,
  updateChatMessages,
} from "./db";
import { runAssistantTurn, sanitizeChart } from "./assistant";
import { buildCoachSystemPrompt, cacheCoachPromptPrefix } from "./coach";
import type { AssistantEvent, ChartSpec } from "./assistant";
import type { ChatMessage } from "./openrouter";
import { parseToolArgs } from "./schemas";
import { onAppResume, wasSuspendedSince } from "./appLifecycle";
import { withBackgroundTask } from "./background";

// ---------------------------------------------------------------------------
// The visible thread
// ---------------------------------------------------------------------------

/**
 * `message`/`chart` are what the agent delivered; `activity` is the collapsed
 * reasoning thread (tool calls + private text) that produced them.
 */
export type UiItem =
  | { kind: "user"; text: string }
  | { kind: "message"; text: string }
  | { kind: "chart"; chart: ChartSpec }
  | { kind: "activity"; reasoning: string[]; tools: string[] };

const TOOL_LABELS: Record<string, string> = {
  query_meals: "meals",
  query_workouts: "workouts",
  query_sleep: "sleep",
  query_health_metrics: "health metrics",
  query_supplements: "supplements",
  query_fasts: "fasts",
  run_sql: "database",
};

export function toolLabel(name: string): string {
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
export function transcriptToUi(messages: ChatMessage[]): UiItem[] {
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type AssistantStatus =
  /** Nothing running; the thread is whatever was last delivered. */
  | "idle"
  /** A turn is in flight right now. */
  | "running"
  /** A turn stopped because the app was suspended — resumes on its own. */
  | "interrupted"
  /** A turn failed for a real reason; the user decides whether to retry. */
  | "error";

export interface AssistantState {
  chatId: number | null;
  items: UiItem[];
  status: AssistantStatus;
  /** Why the turn stopped; null unless status is "error" or "interrupted". */
  error: string | null;
  /** Tool the model is using right now, for the thinking row. */
  activeTool: string | null;
  /**
   * True when the thread should offer "Try again": a turn stopped and there
   * is a user message to run again. Idle threads never offer it.
   */
  canRetry: boolean;
}

let transcript: ChatMessage[] = [];
let chatId: number | null = null;
let items: UiItem[] = [];
let status: AssistantStatus = "idle";
let error: string | null = null;
let activeTool: string | null = null;
/** The in-flight turn, so a second one can't start on top of it. */
let inFlight: Promise<void> | null = null;
/**
 * Whether an interrupted turn may restart by itself. True only for a run this
 * session suspended mid-flight — a stale unanswered turn found in a reopened
 * chat waits for the user to ask for it.
 */
let autoResumable = false;

let snapshot: AssistantState = {
  chatId: null,
  items: [],
  status: "idle",
  error: null,
  activeTool: null,
  canRetry: false,
};
const listeners = new Set<() => void>();

/**
 * Whether there is a user turn to run again at all. Deliberately not "the
 * transcript ends on a user message": a round that failed halfway leaves
 * assistant and tool messages behind it, and that is the very case a retry
 * exists for — `rewindToLastUserTurn` strips them back off.
 */
function hasUserTurn(): boolean {
  return transcript.some((m) => m.role === "user");
}

/**
 * Whether the transcript ends on a user message nobody ever answered — a turn
 * that died with the app rather than one that merely failed.
 */
function endsOnUnansweredTurn(): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const role = transcript[i]?.role;
    if (role === "user") return true;
    if (role === "assistant") return false;
  }
  return false;
}

function emit(): void {
  snapshot = {
    chatId,
    items,
    status,
    error,
    activeTool,
    canRetry:
      (status === "error" || status === "interrupted") && hasUserTurn(),
  };
  for (const fn of listeners) fn();
}

/** `useSyncExternalStore` pair — the snapshot is only rebuilt on a change. */
export function subscribeAssistant(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAssistantState(): AssistantState {
  return snapshot;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let persisting = false;
let persistAgain = false;

/**
 * Write the transcript to the `chats` table. Called after every round, so an
 * interrupted turn keeps what it already produced. Overlapping calls collapse
 * into one trailing write.
 */
async function persist(): Promise<void> {
  if (transcript.length === 0) return;
  if (persisting) {
    persistAgain = true;
    return;
  }
  persisting = true;
  try {
    do {
      persistAgain = false;
      if (chatId == null) {
        const firstUser = transcript.find(
          (m) => m.role === "user" && typeof m.content === "string",
        );
        const title = chatTitle(
          typeof firstUser?.content === "string" ? firstUser.content : "Chat",
        );
        chatId = await createChat(title, transcript);
        emit();
      } else {
        await updateChatMessages(chatId, transcript);
      }
    } while (persistAgain);
  } catch (e) {
    console.error("Could not save chat", e);
  } finally {
    persisting = false;
  }
}

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

function run(): void {
  if (inFlight) return;
  status = "running";
  error = null;
  activeTool = null;
  emit();

  const startedAt = Date.now();
  autoResumable = false;
  inFlight = (async () => {
    try {
      // Rebuilt every turn: it carries the clock, the coach's memory, and a
      // fresh digest of the diary, all of which move between turns.
      await refreshSystemPrompt();
      // Held open so switching away mid-answer no longer drops the request.
      await withBackgroundTask("Answering your question", () =>
        runAssistantTurn(
          transcript,
          (e) => {
            if (e.type === "tool") activeTool = toolLabel(e.name);
            else if (e.type === "message" || e.type === "chart") activeTool = null;
            items = appendEvent(items, e);
            emit();
          },
          { onRound: () => void persist() },
        ),
      );
      status = "idle";
      error = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (wasSuspendedSince(startedAt)) {
        // The OS dropped the request while the app was away. Not the model's
        // fault and not the user's problem — park it and pick it up on return.
        status = "interrupted";
        autoResumable = true;
        error =
          "Paused while the app was in the background — it picks up again when you come back.";
      } else {
        status = "error";
        error = msg;
      }
    } finally {
      activeTool = null;
      inFlight = null;
      emit();
      await persist();
      // The turn may have written to memory, which the scheduled Android
      // check-in reads from the cached prefix rather than rebuilding.
      void cacheCoachPromptPrefix();
    }
  })();
}

/**
 * Drop everything after the last user message so a retry re-runs that turn
 * cleanly: a half-finished round leaves assistant/tool messages the model
 * would otherwise try to continue from, and partial deliveries would show up
 * twice in the thread.
 */
function rewindToLastUserTurn(): void {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i]?.role === "user") {
      transcript = transcript.slice(0, i + 1);
      items = transcriptToUi(transcript);
      return;
    }
  }
}

/**
 * Put the current coach prompt at the head of the transcript, replacing any
 * earlier one. Built fresh because memory and the digest change under it.
 */
async function refreshSystemPrompt(): Promise<void> {
  const system: ChatMessage = { role: "system", content: await buildCoachSystemPrompt() };
  if (transcript[0]?.role === "system") transcript[0] = system;
  else transcript.unshift(system);
}

/** Send a message and run the turn. Never throws — failures land in state. */
export function sendAssistantMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || status === "running") return;

  transcript.push({ role: "user", content: trimmed });
  items = [...items, { kind: "user", text: trimmed }];
  run();
}

/** Re-run the last user turn after a failure or an interruption. */
export function retryAssistant(): void {
  if (status === "running" || !hasUserTurn()) return;
  rewindToLastUserTurn();
  run();
}

/** Back to the chat list. A running turn keeps going and stays reachable. */
export function closeAssistantChat(): void {
  if (status === "running") return;
  transcript = [];
  chatId = null;
  items = [];
  status = "idle";
  error = null;
  activeTool = null;
  emit();
}

/** Open a saved chat. Returns false when it couldn't be read. */
export async function openAssistantChat(id: number): Promise<boolean> {
  if (status === "running") return false;
  const saved = await getChatMessages(id);
  if (!saved) return false;
  transcript = saved;
  chatId = id;
  items = transcriptToUi(saved);
  activeTool = null;
  // A transcript ending on an unanswered user message is a turn that died
  // with the app (killed while suspended, or mid-round). Offer it again
  // rather than leaving the question hanging.
  if (endsOnUnansweredTurn()) {
    status = "interrupted";
    autoResumable = false; // an old chat shouldn't fire off a request on its own
    error = "This turn never finished — the app was closed while it was running.";
  } else {
    status = "idle";
    error = null;
  }
  emit();
  return true;
}

/**
 * Resume an interrupted turn whenever the app returns to the foreground.
 * Call once on app start; returns a cleanup function.
 */
export function installAssistantLifecycle(): () => void {
  return onAppResume(() => {
    if (status === "interrupted" && autoResumable && !inFlight) retryAssistant();
  });
}
