import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONTEXT_HANDOFF_CONFIG,
  INITIAL_CONTEXT_HANDOFF_STATE,
  contextHandoffConfigFromEnv,
  evaluateThreshold,
  type ContextHandoffConfig,
  type ContextHandoffState,
} from "./context-handoff";

const CONFIG: ContextHandoffConfig = DEFAULT_CONTEXT_HANDOFF_CONFIG;

/** Drive a sequence of readings through the detector, collecting each warn edge. */
function run(
  readings: Array<number | null>,
  config: ContextHandoffConfig = CONFIG,
  initial: ContextHandoffState = INITIAL_CONTEXT_HANDOFF_STATE,
): { state: ContextHandoffState; warns: number; warnEdges: boolean[] } {
  let state = initial;
  let warns = 0;
  const warnEdges: boolean[] = [];
  for (const percent of readings) {
    const { nextState, warn } = evaluateThreshold(state, percent, config);
    state = nextState;
    warnEdges.push(warn);
    if (warn) warns += 1;
  }
  return { state, warns, warnEdges };
}

describe("evaluateThreshold", () => {
  test("crossing HIGH (sustained) warns exactly once", () => {
    // Two consecutive HIGH ticks satisfy the default debounce of 2.
    const { warns, state } = run([80, 80]);
    expect(warns).toBe(1);
    expect(state.warned).toBe(true);
    expect(state.armed).toBe(false);
    expect(state.crossingSeq).toBe(1);
  });

  test("a single-tick spike does not warn (debounce)", () => {
    // One HIGH reading then back into the band: never reaches debounceTicks.
    const { warns, state } = run([80, 60]);
    expect(warns).toBe(0);
    expect(state.warned).toBe(false);
    expect(state.highTickCount).toBe(0);
  });

  test("holding well above HIGH warns once, then stays quiet", () => {
    const { warns, state } = run([80, 80, 81, 82, 79, 85]);
    expect(warns).toBe(1);
    expect(state.warned).toBe(true);
    expect(state.armed).toBe(false);
    expect(state.crossingSeq).toBe(1);
  });

  test("hovering 71.9 <-> 72.1 warns zero extra times", () => {
    // First sustained cross warns once; subsequent boundary jitter never
    // re-arms (never dips below LOW=55) so no further warnings fire.
    const readings = [72.1, 72.1, 71.9, 72.1, 71.9, 72.1, 71.9, 72.1];
    const { warns } = run(readings);
    expect(warns).toBe(1);
  });

  test("percent null never warns and holds state", () => {
    const primed = run([80]).state; // one HIGH tick, highTickCount=1, not yet warned
    const afterNulls = run([null, null, null], CONFIG, primed);
    expect(afterNulls.warns).toBe(0);
    expect(afterNulls.state).toEqual(primed);
  });

  test("null between two HIGH ticks does not break through debounce on the null itself", () => {
    // HIGH, null (held), HIGH -> the two real HIGH ticks accumulate; warn on the 2nd HIGH.
    const { warns, warnEdges } = run([80, null, 80]);
    expect(warns).toBe(1);
    expect(warnEdges).toEqual([false, false, true]);
  });

  test("falling below LOW re-arms with a new crossingSeq on the next crossing", () => {
    let state = run([80, 80]).state; // warned once, crossingSeq=1, disarmed
    expect(state.crossingSeq).toBe(1);
    expect(state.armed).toBe(false);

    // Drop below LOW: re-arm, crossingSeq holds at 1 during the quiet period.
    state = evaluateThreshold(state, 40, CONFIG).nextState;
    expect(state.armed).toBe(true);
    expect(state.warned).toBe(false);
    expect(state.crossingSeq).toBe(1);

    // Cross HIGH again (sustained): warns once more with an incremented seq.
    const second = run([80, 80], CONFIG, state);
    expect(second.warns).toBe(1);
    expect(second.state.crossingSeq).toBe(2);
  });

  test("post-compaction null -> low re-arms for the next cycle", () => {
    let state = run([80, 80]).state; // warned, disarmed, seq=1
    // Compaction: Pi reports null for a while (unknown). No warn, state held.
    const held = run([null, null], CONFIG, state);
    expect(held.warns).toBe(0);
    expect(held.state.armed).toBe(false);
    state = held.state;
    // First assistant response after compaction: low usage re-arms.
    state = evaluateThreshold(state, 20, CONFIG).nextState;
    expect(state.armed).toBe(true);
    // Next fill crosses again and warns once with a fresh crossing id.
    const next = run([73, 73], CONFIG, state);
    expect(next.warns).toBe(1);
    expect(next.state.crossingSeq).toBe(2);
  });

  test("does not warn while armed but below HIGH forever", () => {
    const { warns, state } = run([10, 30, 54.9, 55, 60, 71.9, 54, 20]);
    expect(warns).toBe(0);
    expect(state.armed).toBe(true);
  });

  test("non-finite percent is treated as no-signal", () => {
    const primed = run([80]).state;
    const { warns, state } = run([Number.NaN, Number.POSITIVE_INFINITY], CONFIG, primed);
    expect(warns).toBe(0);
    expect(state).toEqual(primed);
  });

  test("respects a configurable debounce of 3 ticks", () => {
    const config: ContextHandoffConfig = { high: 72, low: 55, debounceTicks: 3 };
    expect(run([80, 80], config).warns).toBe(0);
    expect(run([80, 80, 80], config).warns).toBe(1);
  });

  test("band reading resets the debounce counter across a dip", () => {
    // HIGH, then dip into band, then HIGH once: only one HIGH tick after reset.
    const { warns } = run([80, 60, 80]);
    expect(warns).toBe(0);
  });
});

describe("contextHandoffConfigFromEnv", () => {
  test("defaults when unset", () => {
    expect(contextHandoffConfigFromEnv({})).toEqual(DEFAULT_CONTEXT_HANDOFF_CONFIG);
  });

  test("reads valid overrides", () => {
    expect(
      contextHandoffConfigFromEnv({
        PLANNOTATOR_HANDOFF_HIGH_PERCENT: "80",
        PLANNOTATOR_HANDOFF_LOW_PERCENT: "50",
        PLANNOTATOR_HANDOFF_DEBOUNCE_TICKS: "3",
      }),
    ).toEqual({ high: 80, low: 50, debounceTicks: 3 });
  });

  test("falls back when low >= high (non-hysteretic)", () => {
    const config = contextHandoffConfigFromEnv({
      PLANNOTATOR_HANDOFF_HIGH_PERCENT: "50",
      PLANNOTATOR_HANDOFF_LOW_PERCENT: "60",
    });
    expect(config.high).toBe(DEFAULT_CONTEXT_HANDOFF_CONFIG.high);
    expect(config.low).toBe(DEFAULT_CONTEXT_HANDOFF_CONFIG.low);
  });

  test("ignores out-of-range and malformed values", () => {
    expect(
      contextHandoffConfigFromEnv({
        PLANNOTATOR_HANDOFF_HIGH_PERCENT: "-5",
        PLANNOTATOR_HANDOFF_LOW_PERCENT: "nonsense",
        PLANNOTATOR_HANDOFF_DEBOUNCE_TICKS: "0",
      }),
    ).toEqual(DEFAULT_CONTEXT_HANDOFF_CONFIG);
  });
});
