import { expect, test } from 'bun:test';
import { readerStaleness, readerStalenessLabel } from './readerStaleness';

const timeline = (...ids: string[]) => ids.map((messageId) => ({ messageId }));

// Newest first, exactly as the wire and the panel deliver it.
const NEWEST_FIRST = timeline('r5', 'r4', 'r3', 'r2', 'r1');

test('reading the newest response is not stale', () => {
  const state = readerStaleness(NEWEST_FIRST, 'r5');
  expect(state.isStale).toBe(false);
  expect(state.behindBy).toBe(0);
  // Newest-first input, human-readable position: the newest is the LAST of 5.
  expect(state.position).toBe(5);
  expect(state.total).toBe(5);
  expect(state.latestMessageId).toBe('r5');
  expect(readerStalenessLabel(state)).toBe('');
});

test('counts how many responses arrived after the pinned one', () => {
  const state = readerStaleness(NEWEST_FIRST, 'r2');
  expect(state.isStale).toBe(true);
  expect(state.behindBy).toBe(3);
  expect(state.position).toBe(2);
  expect(state.total).toBe(5);
  expect(state.latestMessageId).toBe('r5');
});

test('says how far behind and what you are reading, not a bare number', () => {
  expect(readerStalenessLabel(readerStaleness(NEWEST_FIRST, 'r2'))).toBe(
    "3 newer responses in this pane · you're reading 2 of 5",
  );
  // Singular, because "1 newer responses" is the kind of thing that ships.
  expect(readerStalenessLabel(readerStaleness(NEWEST_FIRST, 'r4'))).toBe(
    "1 newer response in this pane · you're reading 4 of 5",
  );
});

test('a selection from another pane is never reported as up to date', () => {
  // The reader can legitimately hold a response the active pane does not
  // contain. Reporting "0 behind" there would be a false all-clear, and
  // guessing a distance would be a fabrication — so it reports neither.
  const state = readerStaleness(NEWEST_FIRST, 'someone-elses-message');
  expect(state.isStale).toBe(false);
  expect(state.behindBy).toBe(0);
  expect(state.position).toBe(0);
  // The jump target is still known, so the affordance can still be offered.
  expect(state.latestMessageId).toBe('r5');
});

test('degrades quietly on an empty or absent timeline', () => {
  for (const empty of [[], null, undefined]) {
    const state = readerStaleness(empty, 'r1');
    expect(state.isStale).toBe(false);
    expect(state.latestMessageId).toBe(null);
    expect(state.total).toBe(0);
  }
});

test('no selection yet is not stale', () => {
  const state = readerStaleness(NEWEST_FIRST, null);
  expect(state.isStale).toBe(false);
  expect(state.latestMessageId).toBe('r5');
});

test('a single-response pane is never stale', () => {
  const state = readerStaleness(timeline('only'), 'only');
  expect(state.isStale).toBe(false);
  expect(state.position).toBe(1);
  expect(state.total).toBe(1);
});
