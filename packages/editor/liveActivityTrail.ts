// Derives the ordered "what the agent did this turn" trail rendered in the
// Ex-Plannotator live pane header, next to the LiveActivityChip. Everything here
// is computed from `activityTrail` already published on the wire by the Pi
// extension (see apps/ex-pi-extension/herdr-registration.ts) — NAMES ONLY, never
// tool input/output payloads (that is deliberately out of scope; extending the
// capture layer is a separate task).
//
// The chip (liveActivityChip.ts) answers "what is it doing right now?"; this
// trail answers "what did it do to get here?" — e.g. `read → grep ×3 → edit → bash`.

/** One names-only step in the trail, as published on the wire. */
export type LiveActivityTrailEntry = { kind: 'tool' | 'subagent'; name?: string; count: number };

/** A rendered trail step: a stable label plus the collapsed repeat count. */
export type LiveActivityTrailStep = {
  /** Human-readable name, e.g. `grep` or `subagent`. Never empty. */
  label: string;
  /** Collapsed repeat count for consecutive identical steps; >= 1. */
  count: number;
  /** Whether this step is a delegated subagent (styled distinctly by callers). */
  isSubagent: boolean;
};

/** Fallback label when the wire entry carries no name (older/partial frames). */
const fallbackLabel = (kind: LiveActivityTrailEntry['kind']): string =>
  kind === 'subagent' ? 'subagent' : 'tool';

/**
 * Normalize the wire trail into render-ready steps. Defensive against malformed
 * frames: skips non-object entries, clamps counts to a sane positive integer,
 * and coalesces adjacent identical steps (the extension already collapses these,
 * but a republish/merge could produce neighbours, so we keep the display tidy).
 *
 * Returns an empty array when there is nothing to show; callers render nothing.
 */
export const deriveLiveActivityTrail = (
  trail: readonly LiveActivityTrailEntry[] | undefined,
): LiveActivityTrailStep[] => {
  if (!Array.isArray(trail) || trail.length === 0) return [];
  const steps: LiveActivityTrailStep[] = [];
  for (const entry of trail) {
    if (!entry || (entry.kind !== 'tool' && entry.kind !== 'subagent')) continue;
    const isSubagent = entry.kind === 'subagent';
    const label = (typeof entry.name === 'string' && entry.name.trim())
      ? entry.name.trim()
      : fallbackLabel(entry.kind);
    const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1;
    const last = steps[steps.length - 1];
    if (last && last.isSubagent === isSubagent && last.label === label) {
      last.count += count;
    } else {
      steps.push({ label, count, isSubagent });
    }
  }
  return steps;
};

/** Compact one step as `name` or `name ×N`. */
export const formatTrailStep = (step: LiveActivityTrailStep): string =>
  step.count > 1 ? `${step.label} ×${step.count}` : step.label;

/** One-line accessible summary, e.g. `read → grep ×3 → edit → bash`. */
export const formatLiveActivityTrail = (steps: readonly LiveActivityTrailStep[]): string =>
  steps.map(formatTrailStep).join(' → ');
