import { describe, expect, test } from "bun:test";
import {
  classifySubmitAgentStatus,
  COMPOSER_BUSY_REASON,
  COMPOSER_UNREADABLE_REASON,
  DEFAULT_COMPOSER_SEQUENCING,
  deliverViaHerdrComposer,
  type HerdrCliRunner,
} from "./herdr-composer-delivery";

/**
 * Scripted herdr CLI: `agent get` answers come from a queue (last entry
 * repeats), every other call is recorded and succeeds. Sleeps are recorded but
 * never awaited for real time.
 */
function fakeHerdr(agentStatuses: Array<string | null>) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let statusIndex = 0;
  const run: HerdrCliRunner = async (args) => {
    calls.push(args);
    if (args[0] === "agent" && args[1] === "get") {
      const status = agentStatuses[Math.min(statusIndex, agentStatuses.length - 1)];
      statusIndex += 1;
      if (status === null) throw new Error("agent_not_found");
      return { stdout: JSON.stringify({ result: { agent: { agent_status: status } } }) };
    }
    return { stdout: "{}" };
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, run, sleep };
}

const sendTextCalls = (calls: string[][]) => calls.filter((args) => args[0] === "pane" && args[1] === "send-text");
const enterCalls = (calls: string[][]) => calls.filter((args) => args[0] === "pane" && args[1] === "send-keys");

describe("classifySubmitAgentStatus", () => {
  test("working and blocked are submit-active; idle and done are idle; the rest is unknown", () => {
    expect(classifySubmitAgentStatus("working")).toBe("busy");
    // A permission prompt right after Enter means the turn started.
    expect(classifySubmitAgentStatus("blocked")).toBe("busy");
    expect(classifySubmitAgentStatus("idle")).toBe("idle");
    expect(classifySubmitAgentStatus("done")).toBe("idle");
    expect(classifySubmitAgentStatus("sleeping")).toBe("unknown");
    expect(classifySubmitAgentStatus(null)).toBe("unknown");
  });
});

describe("deliverViaHerdrComposer", () => {
  test("refuses a mid-turn pane before typing anything", async () => {
    const herdr = fakeHerdr(["working"]);
    const outcome = await deliverViaHerdrComposer("w:p1", "hello", { run: herdr.run, sleep: herdr.sleep });
    expect(outcome).toEqual({ delivered: false, reason: COMPOSER_BUSY_REASON });
    expect(sendTextCalls(herdr.calls)).toHaveLength(0);
    expect(enterCalls(herdr.calls)).toHaveLength(0);
  });

  test("refuses when the agent state is unreadable, without typing", async () => {
    const herdr = fakeHerdr([null]);
    const outcome = await deliverViaHerdrComposer("w:p1", "hello", { run: herdr.run, sleep: herdr.sleep });
    expect(outcome).toEqual({ delivered: false, reason: COMPOSER_UNREADABLE_REASON });
    expect(sendTextCalls(herdr.calls)).toHaveLength(0);
  });

  test("types once, settles, submits with a named Enter, and confirms from native agent state", async () => {
    // idle baseline, then working on the first post-Enter poll.
    const herdr = fakeHerdr(["idle", "working"]);
    const outcome = await deliverViaHerdrComposer("w:p1", "hello there", { run: herdr.run, sleep: herdr.sleep });
    expect(outcome).toEqual({ delivered: true, confirmed: true });
    const typed = sendTextCalls(herdr.calls);
    expect(typed).toEqual([["pane", "send-text", "w:p1", "hello there"]]);
    expect(enterCalls(herdr.calls)).toEqual([["pane", "send-keys", "w:p1", "enter"]]);
    // The settle happens between typing and the first Enter.
    expect(herdr.sleeps[0]).toBe(DEFAULT_COMPOSER_SEQUENCING.settleMs);
    const sendTextIndex = herdr.calls.findIndex((args) => args[1] === "send-text");
    const enterIndex = herdr.calls.findIndex((args) => args[1] === "send-keys");
    expect(sendTextIndex).toBeLessThan(enterIndex);
  });

  test("a slash-prefixed message gets the longer popup settle before the first Enter", async () => {
    const herdr = fakeHerdr(["idle", "working"]);
    await deliverViaHerdrComposer("w:p1", "/compact keep going", { run: herdr.run, sleep: herdr.sleep });
    expect(herdr.sleeps[0]).toBe(DEFAULT_COMPOSER_SEQUENCING.popupSettleMs);
  });

  test("a dollar-prefixed message also gets the popup settle", async () => {
    const herdr = fakeHerdr(["idle", "working"]);
    await deliverViaHerdrComposer("w:p1", "$skill run", { run: herdr.run, sleep: herdr.sleep });
    expect(herdr.sleeps[0]).toBe(DEFAULT_COMPOSER_SEQUENCING.popupSettleMs);
  });

  test("a swallowed first Enter is retried with Enter only — the text is never retyped", async () => {
    // Baseline idle; the whole first confirmation window stays idle (popup ate
    // Enter), then the second Enter's first poll observes working.
    const firstWindowIdle = Array.from({ length: DEFAULT_COMPOSER_SEQUENCING.confirmPolls }, () => "idle");
    const herdr = fakeHerdr(["idle", ...firstWindowIdle, "working"]);
    const outcome = await deliverViaHerdrComposer("w:p1", "/review this", { run: herdr.run, sleep: herdr.sleep });
    expect(outcome).toEqual({ delivered: true, confirmed: true });
    expect(sendTextCalls(herdr.calls)).toHaveLength(1);
    expect(enterCalls(herdr.calls)).toHaveLength(2);
  });

  test("exhausted Enter attempts report typed-but-unconfirmed, never a silent success or a retype", async () => {
    const herdr = fakeHerdr(["idle"]);
    const outcome = await deliverViaHerdrComposer("w:p1", "hello", { run: herdr.run, sleep: herdr.sleep });
    if (!outcome.delivered || outcome.confirmed) throw new Error(`expected unconfirmed outcome, got ${JSON.stringify(outcome)}`);
    expect(outcome.note).toContain("resending would deliver it twice");
    expect(sendTextCalls(herdr.calls)).toHaveLength(1);
    expect(enterCalls(herdr.calls)).toHaveLength(DEFAULT_COMPOSER_SEQUENCING.enterAttempts);
  });

  test("a blocked status after Enter counts as confirmation — permission prompts mean the turn started", async () => {
    const herdr = fakeHerdr(["idle", "blocked"]);
    const outcome = await deliverViaHerdrComposer("w:p1", "hello", { run: herdr.run, sleep: herdr.sleep });
    expect(outcome).toEqual({ delivered: true, confirmed: true });
  });

  test("a failed send-text reports undelivered without pressing Enter", async () => {
    const calls: string[][] = [];
    const run: HerdrCliRunner = async (args) => {
      calls.push(args);
      if (args[1] === "send-text") throw new Error("pane_not_found");
      return { stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }) };
    };
    const outcome = await deliverViaHerdrComposer("w:p1", "hello", { run, sleep: async () => {} });
    expect(outcome.delivered).toBe(false);
    expect(enterCalls(calls)).toHaveLength(0);
  });
});
