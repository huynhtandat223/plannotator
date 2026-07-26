import { expect, test } from 'bun:test';
import { deriveLiveActivityChip } from './liveActivityChip';

test('working + tool activity → ● Running <name> (animated)', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'tool', name: 'bash', count: 1 } });
  expect(chip).toEqual({ glyph: '●', label: 'Running bash', tone: 'active', animated: true });
});

test('working + tool activity with count > 1 appends ×N', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'tool', name: 'bash', count: 3 } });
  expect(chip?.label).toBe('Running bash ×3');
  expect(chip?.tone).toBe('active');
});

test('working + tool activity without a name falls back to "tool"', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'tool', count: 1 } });
  expect(chip?.label).toBe('Running tool');
});

test('working + subagent activity → ● Subagent (animated)', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'subagent', count: 1 } });
  expect(chip).toEqual({ glyph: '●', label: 'Subagent', tone: 'active', animated: true });
});

test('working + subagent activity with count > 1 appends ×N', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'subagent', count: 2 } });
  expect(chip?.label).toBe('Subagent ×2');
});

test('working with no activity → ● Thinking… (animated)', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working' });
  expect(chip).toEqual({ glyph: '●', label: 'Thinking…', tone: 'active', animated: true });
});

test('idle → ○ Idle', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'idle' });
  expect(chip).toEqual({ glyph: '○', label: 'Idle', tone: 'idle' });
});

test('only the actively-working states are animated', () => {
  // Working states drive the single looping indicator…
  expect(deriveLiveActivityChip({ agentStatus: 'working' })?.animated).toBe(true);
  expect(deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'tool', name: 'bash', count: 1 } })?.animated).toBe(true);
  expect(deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'subagent', count: 1 } })?.animated).toBe(true);
  // …calm states never animate, so motion uniquely signals live work.
  expect(deriveLiveActivityChip({ agentStatus: 'idle' })?.animated).toBeUndefined();
  expect(deriveLiveActivityChip({ agentStatus: 'blocked' })?.animated).toBeUndefined();
  expect(deriveLiveActivityChip({ agentStatus: 'idle', reviewRoundStatus: 'waiting' })?.animated).toBeUndefined();
});

test('reviewRoundStatus waiting → ● Waiting on you', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'idle', reviewRoundStatus: 'waiting' });
  expect(chip).toEqual({ glyph: '●', label: 'Waiting on you', tone: 'waiting' });
});

test('waiting round takes precedence even while the agent is still working', () => {
  const chip = deriveLiveActivityChip({
    agentStatus: 'working',
    activity: { kind: 'tool', name: 'bash', count: 1 },
    reviewRoundStatus: 'waiting',
  });
  expect(chip?.label).toBe('Waiting on you');
});

test('blocked → ▲ Blocked', () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'blocked' });
  expect(chip).toEqual({ glyph: '▲', label: 'Blocked', tone: 'blocked' });
});

test('unknown or absent status with no waiting round → null (nothing to show)', () => {
  expect(deriveLiveActivityChip({ agentStatus: 'unknown' })).toBeNull();
  expect(deriveLiveActivityChip({})).toBeNull();
  expect(deriveLiveActivityChip({ reviewRoundStatus: 'open' })).toBeNull();
});
