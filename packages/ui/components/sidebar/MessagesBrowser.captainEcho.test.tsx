/**
 * Browser-local captain echo rendering in the live message list.
 *
 * Guards the parts of the locked decision that are visual contracts:
 *  - the captain's sent text appears in the list (the two-sided transcript);
 *  - it is labelled `local` with an honest tooltip, so it never reads as
 *    server-confirmed history;
 *  - it is NOT a button, so it can never be selected as an annotation or review
 *    target and cannot reach the `assistantMessageId` identity contract;
 *  - it does not shift the `#N` numbering of real snapshot rows.
 */

import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessagesBrowser, type PickerMessage } from './MessagesBrowser';
import { resetStorageBackend, setStorageBackend } from '../../utils/storage';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function useMemoryStorage(): void {
  const store = new Map<string, string>();
  setStorageBackend({
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); },
  });
}

const MESSAGES: PickerMessage[] = [
  { messageId: 'pane-a:r2', paneId: 'pane-a', piSessionId: 's1', assistantMessageId: 'r2', text: 'Newest agent response' },
  { messageId: 'pane-a:r1', paneId: 'pane-a', piSessionId: 's1', assistantMessageId: 'r1', text: 'Older agent response' },
];

async function render(node: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  resetStorageBackend();
});

test.skipIf(!hasDom)('renders the captain echo as a non-selectable, honestly labelled row', async () => {
  useMemoryStorage();
  const echoes = new Map([['pane-a:r2', [{ id: 'e1', text: 'Please rerun the failing test', timestamp: undefined }]]]);
  const container = await render(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} captainEchoes={echoes} />,
  );

  expect(container.textContent).toContain('Please rerun the failing test');

  const echoRow = container.querySelector('[data-captain-echo="true"]');
  expect(echoRow).not.toBeNull();
  // Never a button: an echo cannot be chosen as an annotation/review target.
  expect(echoRow!.tagName).not.toBe('BUTTON');
  expect(echoRow!.querySelector('button')).toBeNull();

  // Honest affordance: a `local` marker plus a tooltip scoping it to this browser.
  expect(echoRow!.textContent).toContain('local');
  const marker = echoRow!.querySelector('[title]');
  expect(marker?.getAttribute('title')?.toLowerCase()).toContain('this browser session');

  // Attribution reads as the captain's own turn, not the agent's.
  expect(echoRow!.textContent).toContain('You');
});

test.skipIf(!hasDom)('echo rows do not shift real response numbering', async () => {
  useMemoryStorage();
  const echoes = new Map([['pane-a:r2', [
    { id: 'e1', text: 'second sent message' },
    { id: 'e2', text: 'first sent message' },
  ]]]);
  const container = await render(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} captainEchoes={echoes} />,
  );

  // Both echoes render, and the two snapshot rows keep #1/#2.
  expect(container.querySelectorAll('[data-captain-echo="true"]').length).toBe(2);
  const rowNumbers = Array.from(container.querySelectorAll('button'))
    .map((button) => button.textContent ?? '')
    .filter((text) => text.includes('#'))
    .map((text) => text.match(/#(\d+)/)?.[1]);
  expect(rowNumbers).toEqual(['1', '2']);
});

test.skipIf(!hasDom)('no echoes means the list is exactly the snapshot', async () => {
  useMemoryStorage();
  const container = await render(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} />,
  );
  expect(container.querySelector('[data-captain-echo="true"]')).toBeNull();
  expect(container.textContent).toContain('Newest agent response');
});
