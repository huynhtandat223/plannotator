// Derives the live "currently doing" chip shown next to the agent status pill in
// the Ex-Plannotator live pane. Everything here is computed from data already on the
// wire (agentStatus + activity from the Herdr snapshot, and the locally-known review
// round status) — see packages/editor/App.tsx live pane header near the status pill.
//
// The chip promotes the buried activity token into a legible, high-contrast signal so
// the captain can tell at a glance whether the agent is thinking, running a tool,
// delegating to a subagent, idle, waiting on them, or blocked.

/** Authoritative live agent state from the Herdr snapshot. */
export type LiveAgentStatus = 'working' | 'idle' | 'blocked' | 'unknown';

/** Tool / subagent activity reported by the Pi extension. */
export type LiveActivity = { kind: 'tool' | 'subagent'; name?: string; count: number };

/** Visual/semantic tone the caller maps to concrete styling. */
export type LiveActivityChipTone = 'active' | 'idle' | 'blocked' | 'waiting';

export type LiveActivityChip = {
  /** Decorative leading glyph; never the sole carrier of meaning (label always set). */
  glyph: '●' | '○' | '▲';
  /** Human-readable status text — the accessible label of the chip. */
  label: string;
  /** Semantic tone for styling; meaning is also conveyed by {@link label}. */
  tone: LiveActivityChipTone;
  /**
   * True only for the "actively working right now" states (running a tool,
   * delegating to a subagent, or thinking). The renderer turns this into ONE
   * looping animated indicator (honoring prefers-reduced-motion) so motion
   * uniquely signals live work. Calm states (idle/blocked/waiting) leave this
   * unset and keep static indicators. Meaning is always carried by {@link label},
   * never by the animation alone.
   */
  animated?: boolean;
};

export type LiveActivityChipInput = {
  agentStatus?: LiveAgentStatus;
  activity?: LiveActivity;
  /** Locally-known review round status; 'waiting' means the round is awaiting the captain. */
  reviewRoundStatus?: string | null;
};

const countSuffix = (count: number): string => (count > 1 ? ` ×${count}` : '');

/**
 * Reduce the live wire state to a single chip descriptor, or null when there is
 * nothing meaningful to show. Branch precedence (highest first):
 *   1. review round waiting on the captain  → ● Waiting on you
 *   2. blocked                              → ▲ Blocked
 *   3. working + tool activity              → ◐ Running <name> [×N] (animated)
 *   4. working + subagent activity          → ◐ Subagent [×N]     (animated)
 *   5. working, no activity                 → ◐ Thinking…          (animated)
 *   6. idle                                 → ○ Idle
 */
export const deriveLiveActivityChip = (input: LiveActivityChipInput): LiveActivityChip | null => {
  const { agentStatus, activity, reviewRoundStatus } = input;

  // A round awaiting the captain takes precedence: it is the one state that needs a human.
  if (reviewRoundStatus === 'waiting') {
    return { glyph: '●', label: 'Waiting on you', tone: 'waiting' };
  }

  if (agentStatus === 'blocked') {
    return { glyph: '▲', label: 'Blocked', tone: 'blocked' };
  }

  if (agentStatus === 'working') {
    if (activity?.kind === 'tool') {
      const name = activity.name ?? 'tool';
      return { glyph: '●', label: `Running ${name}${countSuffix(activity.count)}`, tone: 'active', animated: true };
    }
    if (activity?.kind === 'subagent') {
      return { glyph: '●', label: `Subagent${countSuffix(activity.count)}`, tone: 'active', animated: true };
    }
    return { glyph: '●', label: 'Thinking…', tone: 'active', animated: true };
  }

  if (agentStatus === 'idle') {
    return { glyph: '○', label: 'Idle', tone: 'idle' };
  }

  // 'unknown' or absent status with no waiting round: nothing legible to promote.
  return null;
};
