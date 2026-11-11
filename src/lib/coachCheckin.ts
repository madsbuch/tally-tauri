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
import {
  aiSpendSince,
  clearFollowUps,
  createChat,
  getSetting,
  listDueFollowUps,
  todayStr,
} from "./db";
import { runAssistantTurn } from "./assistant";
import { buildCoachContext, buildCoachDigest, buildCoachSystemPrompt } from "./coach";
import { checkinDailyBudget } from "./coachModel";
import {
  TRIGGERS_BY_KEY,
  evaluateTriggers,
  loadCoachTriggers,
  loadTriggerHistory,
  occasionFor,
  recordTriggerRun,
  shiftDay,
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
  reason: Evaluation["reason"] | "no-key" | "busy" | "failed" | "spend-cap";
  chatId?: number;
}

let inFlight = false;
/** Epoch ms of the last evaluation, to avoid re-deciding on every resume. */
let lastEvaluatedAt = 0;
const MIN_EVALUATION_GAP_MS = 10 * 60_000;
/**
 * A check-in is one message, not an investigation: fewer steps than a chat
 * turn gets, since nobody asked for it and every step resends the prompt.
 */
const CHECKIN_MAX_ROUNDS = 6;

function shortDate(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

async function notify(chatId: number, title: string, body: string): Promise<void> {
  try {
    if (!(await ensureNotificationPermission())) return;
    // On Android the coach plugin posts it — the same notification the
    // scheduled check-in posts with the app closed, carrying the chat's id so
    // a tap opens this conversation.
    const posted = await invoke<boolean>("plugin:coach|notify_checkin", {
      chatId,
      title,
      body,
    }).catch(() => false);
    if (posted) return;
    // Elsewhere a plain one: there's no tap to route.
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
    // The daily cap. Asking for one from Settings is spending on purpose, so
    // that goes through regardless.
    const budget = opts.force ? null : await checkinDailyBudget();
    if (budget != null && (await aiSpendSince(today, "checkin")).costUsd >= budget) {
      return { sent: false, reason: "spend-cap" };
    }
    const [digest, yesterday, triggers, history, due] = await Promise.all([
      buildCoachDigest(today),
      buildCoachDigest(shiftDay(today, -1)),
      loadCoachTriggers(),
      loadTriggerHistory(today),
      listDueFollowUps(today).catch(() => []),
    ]);

    const evaluation = evaluateTriggers({
      digest,
      yesterday,
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
    const [system, context] = await Promise.all([
      buildCoachSystemPrompt(),
      buildCoachContext({ occasion: occasionFor(evaluation) }),
    ]);
    const transcript: ChatMessage[] = [
      { role: "system", content: system },
      context,
      { role: "user", content: INSTRUCTION },
    ];

    // Every request is logged as it's made (lib/openrouter.ts), so a failed
    // check-in still counts against the day's budget.
    let firstMessage = "";
    await withBackgroundTask("Coach check-in", () =>
      runAssistantTurn(
        transcript,
        (e) => {
          if (e.type === "message" && !firstMessage) firstMessage = e.text;
        },
        { purpose: "checkin", maxRounds: CHECKIN_MAX_ROUNDS },
      ),
    );
    if (!firstMessage) return { sent: false, reason: "failed" };

    // Drop the synthetic instruction, leaving [system, context, assistant, …].
    const saved = transcript.filter((m) => m.content !== INSTRUCTION);
    const title = `${def?.title ?? "Check-in"} · ${shortDate(today)}`;
    const chatId = await createChat(title, saved);

    await recordTriggerRun(winner.key, today, chatId);
    // What keeps it findable when the notification is swiped away unread:
    // the app asks this on the way back in, and marks the Coach tab.
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
    await notify(chatId, def?.title ?? "Your coach", firstMessage.replace(/[*_`#]/g, ""));
    return { sent: true, reason: "ok", chatId };
  } catch (e) {
    console.warn("Coach check-in failed", e);
    return { sent: false, reason: "failed" };
  } finally {
    inFlight = false;
  }
}
