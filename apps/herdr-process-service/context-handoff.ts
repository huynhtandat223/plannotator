/**
 * Context-window handoff threshold detector (pure, server-side).
 *
 * A Schmitt-trigger + debounce state machine that decides, per live Pi pane,
 * when context usage has crossed a high-water mark and the captain should be
 * warned to hand off. It is intentionally I/O-free and unit-testable: the
 * owning `herdr-process-service` feeds it each pane's `contextUsage.percent`
 * on the existing 2s snapshot refresh and stores the returned `nextState`.
 *
 * Design (see the plannotator-context-handoff-daemon scout report):
 * - Arm-and-warn at HIGH (default 72%); do NOT re-arm until percent falls
 *   below LOW (default 55%). The hysteresis gap prevents chatter at the
 *   boundary (e.g. hovering 71.9 <-> 72.1 never warns twice).
 * - `percent === null` is "no signal": hold prior state, never warn, never
 *   re-arm on it. Right after compaction Pi reports null until the next
 *   assistant response; a later low reading naturally re-arms.
 * - Debounce: HIGH must hold for `debounceTicks` consecutive readings (~4s at
 *   the 2s poll) before warning, so a single spiky reading is ignored.
 * - Warn-once per crossing: firing sets `armed=false`; only a return below LOW
 *   re-arms. `crossingSeq` is a monotonic id incremented on each fire so the
 *   UI can distinguish one crossing's warning from the next.
 *
 * NOTE: this module never sends a command. It only detects + reports. The
 * manual "Hand off" action is triggered by the captain in the UI.
 */

export type ContextHandoffConfig = {
  /** Arm-and-warn threshold (percent, 0-100). */
  high: number;
  /** Re-arm threshold (percent, 0-100); must be < high for hysteresis. */
  low: number;
  /** Consecutive HIGH readings required before warning (debounce). */
  debounceTicks: number;
};

export const DEFAULT_CONTEXT_HANDOFF_CONFIG: ContextHandoffConfig = {
  high: 72,
  low: 55,
  debounceTicks: 2,
};

/**
 * Per-pane detector state. Kept beside the coordinator store in the service.
 * - `armed`: ready to warn on the next sustained HIGH crossing.
 * - `crossingSeq`: monotonic id, bumped each time a warning fires.
 * - `highTickCount`: consecutive HIGH readings seen so far (debounce counter).
 * - `warned`: a warning is currently active for this crossing (held until a
 *   sub-LOW reading re-arms). This is the value the snapshot publishes.
 */
export type ContextHandoffState = {
  armed: boolean;
  crossingSeq: number;
  highTickCount: number;
  warned: boolean;
};

export const INITIAL_CONTEXT_HANDOFF_STATE: ContextHandoffState = {
  armed: true,
  crossingSeq: 0,
  highTickCount: 0,
  warned: false,
};

export type ThresholdEvaluation = {
  nextState: ContextHandoffState;
  /** True only on the tick a warning first fires (the rising edge). */
  warn: boolean;
};

/**
 * Read the config from environment variables, falling back to defaults. Invalid
 * or non-hysteretic values (low >= high) fall back so the detector can never be
 * mis-configured into chatter.
 */
export function contextHandoffConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ContextHandoffConfig {
  const high = parsePercent(env.PLANNOTATOR_HANDOFF_HIGH_PERCENT, DEFAULT_CONTEXT_HANDOFF_CONFIG.high);
  const low = parsePercent(env.PLANNOTATOR_HANDOFF_LOW_PERCENT, DEFAULT_CONTEXT_HANDOFF_CONFIG.low);
  const debounceTicks = parseTicks(env.PLANNOTATOR_HANDOFF_DEBOUNCE_TICKS, DEFAULT_CONTEXT_HANDOFF_CONFIG.debounceTicks);
  if (!(low < high)) return { ...DEFAULT_CONTEXT_HANDOFF_CONFIG, debounceTicks };
  return { high, low, debounceTicks };
}

function parsePercent(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) return fallback;
  return value;
}

function parseTicks(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) return fallback;
  return value;
}

/**
 * Advance the per-pane detector by one snapshot tick.
 *
 * Pure: given the same `(prevState, percent, config)` it always returns the
 * same result and mutates nothing.
 */
export function evaluateThreshold(
  prevState: ContextHandoffState,
  percent: number | null,
  config: ContextHandoffConfig = DEFAULT_CONTEXT_HANDOFF_CONFIG,
): ThresholdEvaluation {
  // No signal: hold prior state. Never warn, never re-arm on a null reading.
  // (This is the post-compaction / pre-first-response state.)
  if (percent === null || !Number.isFinite(percent)) {
    return { nextState: prevState, warn: false };
  }

  // Below LOW: re-arm for the next crossing. crossingSeq is unchanged here; it
  // only advances when a warning fires, so the id stays stable across the quiet
  // period and identifies the *next* crossing once it fires.
  if (percent < config.low) {
    if (prevState.armed && prevState.highTickCount === 0 && !prevState.warned) {
      return { nextState: prevState, warn: false };
    }
    return {
      nextState: { armed: true, crossingSeq: prevState.crossingSeq, highTickCount: 0, warned: false },
      warn: false,
    };
  }

  // Between LOW and HIGH (the hysteresis band): hold arming/warned state but
  // reset the debounce counter, so a non-sustained blip toward HIGH cannot
  // accumulate across dips back into the band.
  if (percent < config.high) {
    if (prevState.highTickCount === 0) return { nextState: prevState, warn: false };
    return { nextState: { ...prevState, highTickCount: 0 }, warn: false };
  }

  // At or above HIGH.
  // Already warned this crossing (disarmed): hold, keep the warning shown, but
  // never re-fire until a sub-LOW reading re-arms.
  if (!prevState.armed) {
    return { nextState: prevState, warn: false };
  }

  const highTickCount = prevState.highTickCount + 1;
  if (highTickCount < config.debounceTicks) {
    // Debounce not yet satisfied: count the tick, do not warn.
    return { nextState: { ...prevState, highTickCount }, warn: false };
  }

  // Debounce satisfied: fire once. Disarm and bump the monotonic crossing id.
  return {
    nextState: { armed: false, crossingSeq: prevState.crossingSeq + 1, highTickCount, warned: true },
    warn: true,
  };
}
