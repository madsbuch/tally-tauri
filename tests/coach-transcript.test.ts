import { describe, expect, test } from "bun:test";
import {
  COACH_CONTEXT_MARK,
  STALE_CONTEXT,
  compactTranscript,
  isCoachContext,
  lastUserIndexOf,
} from "../src/lib/coachTranscript";
import type { ChatMessage } from "../src/lib/schemas";

const big = "x".repeat(2000);

function call(id: string, name: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

function conversation(): ChatMessage[] {
  return [
    { role: "system", content: "prompt" },
    { role: "user", content: `${COACH_CONTEXT_MARK} Monday digest` },
    { role: "user", content: "How was my week?" },
    call("a", "run_sql"),
    { role: "tool", tool_call_id: "a", content: big },
    call("b", "describe_database"),
    { role: "tool", tool_call_id: "b", content: big },
    call("c", "query_sleep"),
    { role: "tool", tool_call_id: "c", content: "short" },
    { role: "user", content: `${COACH_CONTEXT_MARK} Tuesday digest` },
    { role: "user", content: "And sleep?" },
  ];
}

describe("coach transcript", () => {
  test("context notes are not their messages", () => {
    const msgs = conversation();
    expect(isCoachContext(msgs[1]!)).toBe(true);
    expect(isCoachContext(msgs[2]!)).toBe(false);
    expect(lastUserIndexOf(msgs)).toBe(10);
  });

  test("shortens earlier results and notes, keeps the live turn", () => {
    const out = compactTranscript(conversation());
    expect(out[1]!.content).toBe(STALE_CONTEXT);
    expect(out[4]!.content).toContain("run_sql result from an earlier turn");
    // The schema stays: it would only be fetched again.
    expect(out[6]!.content).toBe(big);
    expect(out[8]!.content).toBe("short");
    // The live note and the message being answered are untouched.
    expect(out[9]!.content).toBe(`${COACH_CONTEXT_MARK} Tuesday digest`);
    expect(out[10]!.content).toBe("And sleep?");
  });

  test("is stable: compacting twice changes nothing", () => {
    const once = compactTranscript(conversation());
    expect(compactTranscript(once)).toEqual(once);
  });

  test("leaves the current turn's results alone", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "Q" },
      call("a", "run_sql"),
      { role: "tool", tool_call_id: "a", content: big },
    ];
    expect(compactTranscript(msgs)).toEqual(msgs);
  });
});
