/**
 * Ordered activity-trail derivation for the Ex-Plannotator live pane.
 *
 * The trail is names-only ("what did the agent do this turn") and is derived
 * purely from the `activityTrail` array already on the wire. These guard the
 * contract the header rendering depends on:
 *  - order is preserved (oldest → newest);
 *  - consecutive identical steps collapse into `×N`;
 *  - malformed / payload-less frames never throw and never leak a payload;
 *  - the one-line summary reads like `read → grep ×3 → edit → bash`.
 */

import { expect, test } from 'bun:test';
import {
  deriveLiveActivityTrail,
  formatLiveActivityTrail,
  formatTrailStep,
  type LiveActivityTrailEntry,
} from './liveActivityTrail';

test('empty or missing trail yields no steps', () => {
  expect(deriveLiveActivityTrail(undefined)).toEqual([]);
  expect(deriveLiveActivityTrail([])).toEqual([]);
});

test('preserves order and renders the canonical arrow summary', () => {
  const trail: LiveActivityTrailEntry[] = [
    { kind: 'tool', name: 'read', count: 1 },
    { kind: 'tool', name: 'grep', count: 3 },
    { kind: 'tool', name: 'edit', count: 1 },
    { kind: 'tool', name: 'bash', count: 1 },
  ];
  const steps = deriveLiveActivityTrail(trail);
  expect(steps.map((s) => s.label)).toEqual(['read', 'grep', 'edit', 'bash']);
  expect(formatLiveActivityTrail(steps)).toBe('read → grep ×3 → edit → bash');
});

test('coalesces adjacent identical steps that survived a merge', () => {
  const steps = deriveLiveActivityTrail([
    { kind: 'tool', name: 'grep', count: 2 },
    { kind: 'tool', name: 'grep', count: 1 },
    { kind: 'tool', name: 'read', count: 1 },
  ]);
  expect(steps).toEqual([
    { label: 'grep', count: 3, isSubagent: false },
    { label: 'read', count: 1, isSubagent: false },
  ]);
});

test('keeps a subagent step distinct from a same-named tool step', () => {
  const steps = deriveLiveActivityTrail([
    { kind: 'subagent', name: 'subagent', count: 1 },
    { kind: 'tool', name: 'subagent', count: 1 },
  ]);
  expect(steps).toHaveLength(2);
  expect(steps[0].isSubagent).toBe(true);
  expect(steps[1].isSubagent).toBe(false);
});

test('is defensive against malformed entries without throwing', () => {
  const steps = deriveLiveActivityTrail([
    { kind: 'tool', name: '  ', count: 0 } as LiveActivityTrailEntry,
    { kind: 'bogus' as 'tool', name: 'x', count: 1 } as LiveActivityTrailEntry,
    { kind: 'subagent', count: -2 } as LiveActivityTrailEntry,
  ]);
  // First entry: blank name → fallback 'tool', count clamped to 1.
  // Second entry: invalid kind → skipped.
  // Third entry: no name → fallback 'subagent', count clamped to 1.
  expect(steps).toEqual([
    { label: 'tool', count: 1, isSubagent: false },
    { label: 'subagent', count: 1, isSubagent: true },
  ]);
});

test('formatTrailStep omits ×1 but shows higher counts', () => {
  expect(formatTrailStep({ label: 'read', count: 1, isSubagent: false })).toBe('read');
  expect(formatTrailStep({ label: 'grep', count: 4, isSubagent: false })).toBe('grep ×4');
});
