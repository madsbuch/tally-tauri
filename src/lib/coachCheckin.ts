/**
 * Running a coach-initiated check-in.
 *
 * The decision of whether to speak is made in lib/coachTriggers.ts without a
 * model. This module only acts on a decision that's already been taken: build
 * the prompt, run one turn, save it as a chat the coach opened, and post a
 * notification.
 *
 * It deliberately does not touch the live chat in lib/assistantRunner.ts. You
 * might be mid-conversation when a check-in comes due, and having it graft
 * itself onto that thread would be baffling.
 */
import { invoke } from "@tauri-apps/api/core";
import { clearFollowUps, createChat, getSetting, listDueFollowUps, todayStr } from "./db";
import { runAssistantTurn } from "./assistant";
import { buildCoachDigest, buildCoachSystemPrompt } from "./coach";
import {
  TRIGGERS_BY_KEY,
  evaluateTriggers,
  loadCoachTriggers,
  loadTriggerHistory,
  occasionFor,
  recordTriggerRun,
} from "./coachTriggers";
import type { Evaluation } from "./coachTriggers";
import { markCheckinUnread } from "./coachInbox";
import { withBackgroundTask } from "./background";
import { ensureNotificationPermission } from "./fasting";
import { SETTING_KEYS } from "./types";
import type { ChatMessage } from "./openrouter";

/** Notification id for coach check-ins; reused so they replace each other. */
const NOTIFICATION_ID = 4219;

/**
 * The turn is driven by a user-role instruction because that's the shape the
 * chat API wants, but the user never wrote it — so it's stripped back out
 * before the chat is saved, leaving a thread that opens with the coach
 * speaking. Anything else would put words in their mouth.
 */
const INSTRUCTION =
  "Deliver your check-in now, following the occasion described in your instructions.";

export interface CheckinResult {
  sent: boolean;
  reason: Evaluation["reason"] | "no-key" | "busy" | "failed";
  chatId?: number;
}

let inFlight = false;
/** Epoch ms of the last evaluation, to avoid re-deciding on every resume. */
let lastEvaluatedAt = 0;
const MIN_EVALUATION_GAP_MS = 10 * 60_000;

function shortDate(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

async function notify(title: string, body: string): Promise<void> {
  try {
    if (!(await ensureNotificationPermission())) return;
    await invoke("plugin:notification|notify", {
      options: { id: NOTIFICATION_ID, title, body },
    });
  } catch (e) {
    // The check-in is saved either way; it just won't announce itself.
    console.warn("Could not post coach notification", e);
  }
}

/**
 * Evaluate the triggers and, if one wins, run the check-in.
 *
 * `force` skips the throttle and the "already spoke today" budget — it's for
 * the Settings button that lets you hear from the coach on demand.
 */
export async function runCoachCheckin(
  opts: { force?: boolean } = {},
): Promise<CheckinResult> {
  if (inFlight) return { sent: false, reason: "busy" };
  const now = Date.now();
  if (!opts.force && now - lastEvaluatedAt < MIN_EVALUATION_GAP_MS) {
    return { sent: false, reason: "nothing" };
  }

  inFlight = true;
  try {
    const apiKey = await getSetting(SETTING_KEYS.openrouterApiKey).catch(() => null);
    if (!apiKey) return { sent: false, reason: "no-key" };

    lastEvaluatedAt = now;
    const today = todayStr();
    const [digest, triggers, history, due] = await Promise.all([
      buildCoachDigest(today),
      loadCoachTriggers(),
      loadTriggerHistory(today),
      listDueFollowUps(today).catch(() => []),
    ]);

    const evaluation = evaluateTriggers({
      digest,
      hour: new Date().getHours(),
      triggers,
      dueFollowUps: due.map((m) => ({
        id: m.id,
        text: m.text,
        followUpOn: m.follow_up_on ?? today,
      })),
      // Forcing ignores today's budget but still honours cooldowns, so a
      // manual run can't spam the same condition over and over.
      history: opts.force ? history.filter((h) => h.day !== today) : history,
      today,
    });
    if (!evaluation.winner) return { sent: false, reason: evaluation.reason };

    const winner = evaluation.winner;
    const def = TRIGGERS_BY_KEY.get(winner.key);
    const transcript: ChatMessage[] = [
      {
        role: "system",
        content: await buildCoachSystemPrompt({ occasion: occasionFor(evaluation) }),
      },
      { role: "user", content: INSTRUCTION },
    ];

    let firstMessage = "";
    await withBackgroundTask("Coach check-in", () =>
      runAssistantTurn(transcript, (e) => {
        if (e.type === "message" && !firstMessage) firstMessage = e.text;
      }),
    );
    if (!firstMessage) return { sent: false, reason: "failed" };

    // Drop the synthetic instruction, leaving [system, assistant, …].
    const saved = transcript.filter((m) => m.content !== INSTRUCTION);
    const title = `${def?.title ?? "Check-in"} · ${shortDate(today)}`;
    const chatId = await createChat(title, saved);

    await recordTriggerRun(winner.key, today, chatId);
    // What makes it findable: the notification can't say which chat it means,
    // so the app asks this on the way back in.
    await markCheckinUnread(chatId).catch(() => {
      /* the chat is saved either way; it just won't announce itself */
    });
    // A reminder fires once. The coach re-arms it from inside the turn if the
    // thing still needs watching; clearing here means one it forgot to close
    // can't come back tomorrow and crowd out everything else.
    if (winner.key === "follow_up_due") {
      await clearFollowUps(due.map((m) => m.id)).catch(() => {
        /* it will simply be raised again */
      });
    }
    await notify(def?.title ?? "Your coach", firstMessage.replace(/[*_`#]/g, ""));
    return { sent: true, reason: "ok", chatId };
  } catch (e) {
    console.warn("Coach check-in failed", e);
    return { sent: false, reason: "failed" };
  } finally {
    inFlight = false;
  }
}
