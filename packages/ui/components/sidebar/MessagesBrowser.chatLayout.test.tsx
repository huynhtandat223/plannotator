/**
 * Two-sided chat-layout rendering for the Ex-Plannotator live transcript.
 *
 * Guards the Part 1 visual + semantic contract:
 *  - agent turns stay selectable <button> annotation targets even as bubbles;
 *  - captain echoes remain non-selectable, honestly-labelled rows (never
 *    annotation targets) and, in the chronological transcript, sit BELOW the
 *    latest agent turn (a captain follow-up comes after the agent reply);
 *  - the per-pane budget keeps the NEWEST rows in chronological mode, so the
 *    latest turn is always visible and `+N more` reveals older turns.
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

// Oldest-first, as the live host passes a reversed copy for the chronological transcript.
const MESSAGES: PickerMessage[] = [
  { messageId: 'pane-a:r1', paneId: 'pane-a', piSessionId: 's1', assistantMessageId: 'r1', text: 'Older agent response' },
  { messageId: 'pane-a:r2', paneId: 'pane-a', piSessionId: 's1', assistantMessageId: 'r2', text: 'Newest agent response' },
];

async function render(node: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}

/**
 * happy-dom performs no layout, so a scroll test has to supply the metrics the
 * component reads. The host div is the nearest scrollable ancestor, exactly as
 * `OverlayScrollArea` is in the live panel.
 */
async function renderInScroller(
  node: React.ReactElement,
  metrics: { scrollHeight: number; clientHeight: number },
): Promise<HTMLElement> {
  host = document.createElement('div');
  host.style.overflowY = 'auto';
  Object.defineProperty(host, 'scrollHeight', { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: metrics.clientHeight, configurable: true });
  document.body.appendChild(host);
  const mount = document.createElement('div');
  host.appendChild(mount);
  root = createRoot(mount);
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

test.skipIf(!hasDom)('agent turns are selectable buttons in chat layout', async () => {
  useMemoryStorage();
  const container = await render(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout />,
  );
  const buttons = Array.from(container.querySelectorAll('button'));
  const agentButtons = buttons.filter((b) => (b.textContent ?? '').includes('agent response'));
  expect(agentButtons.length).toBe(2);
  // Selection semantics are preserved on the bubble button.
  const selected = container.querySelector('[aria-current="true"]');
  expect(selected).not.toBeNull();
  expect(selected!.tagName).toBe('BUTTON');
  expect(selected!.textContent).toContain('Newest agent response');
});

test.skipIf(!hasDom)('captain echo is a non-selectable bubble below the latest agent turn', async () => {
  useMemoryStorage();
  // Echoes are stored newest-first; the newest agent row (last, chronological) anchors them.
  const echoes = new Map([['pane-a:r2', [
    { id: 'e2', text: 'Second captain prompt', timestamp: undefined },
    { id: 'e1', text: 'First captain prompt', timestamp: undefined },
  ]]]);
  const container = await render(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout captainEchoes={echoes} />,
  );

  const echoRow = container.querySelector('[data-captain-echo="true"]');
  expect(echoRow).not.toBeNull();
  // Never a button — echoes cannot become annotation/review targets.
  expect(echoRow!.tagName).not.toBe('BUTTON');
  expect(echoRow!.querySelector('button')).toBeNull();
  expect(echoRow!.textContent).toContain('local');

  // Order: newest agent turn, then captain echoes oldest-first at the very bottom.
  const text = container.textContent ?? '';
  const agentAt = text.indexOf('Newest agent response');
  const firstEchoAt = text.indexOf('First captain prompt');
  const secondEchoAt = text.indexOf('Second captain prompt');
  expect(agentAt).toBeGreaterThanOrEqual(0);
  expect(agentAt).toBeLessThan(firstEchoAt);
  expect(firstEchoAt).toBeLessThan(secondEchoAt);
});

test.skipIf(!hasDom)('chronological budget keeps the newest rows and pages older ones', async () => {
  useMemoryStorage();
  // 6 oldest-first responses; default quota is 3 → keep the newest 3 (tail).
  const messages: PickerMessage[] = Array.from({ length: 6 }, (_, i) => ({
    messageId: `pane-a:r${i + 1}`,
    paneId: 'pane-a',
    piSessionId: 's1',
    assistantMessageId: `r${i + 1}`,
    text: `Response ${i + 1}`,
  }));
  const container = await render(
    <MessagesBrowser messages={messages} selectedMessageId="pane-a:r6" onSelect={() => {}} chronological chatLayout />,
  );
  const text = container.textContent ?? '';
  // Newest three visible; older three hidden behind the pager.
  expect(text).toContain('Response 6');
  expect(text).toContain('Response 4');
  expect(text).not.toContain('Response 3');
  const pager = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('more'));
  expect(pager).toBeTruthy();
  expect(pager!.textContent).toContain('+3 more');

  await act(async () => { pager!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect((container.textContent ?? '')).toContain('Response 1');
});

test.skipIf(!hasDom)('a chat transcript shows one conversation, so it drops the workspace section heading', async () => {
  useMemoryStorage();
  const messages = MESSAGES.map((message) => ({ ...message, paneLabel: 'firstmate' }));
  const container = await render(
    <MessagesBrowser messages={messages} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout />,
  );
  expect(container.textContent).not.toContain('firstmate');
  // Both turns still render — only the redundant heading is gone.
  expect(container.textContent).toContain('Older agent response');
  expect(container.textContent).toContain('Newest agent response');

  // The non-chat picker is a cross-pane list and keeps its grouping.
  await act(async () => { root!.render(
    <MessagesBrowser messages={messages} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological />,
  ); });
  expect(container.textContent).toContain('firstmate');
});

test.skipIf(!hasDom)('showListLabel hides a caption a host already renders in its own chrome', async () => {
  useMemoryStorage();
  const container = await render(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout showCountControl={false} />,
  );
  expect(container.textContent).toContain('Recent responses — oldest first');

  await act(async () => { root!.render(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout showCountControl={false} showListLabel={false} />,
  ); });
  expect(container.textContent).not.toContain('Recent responses — oldest first');
});

test.skipIf(!hasDom)('pinLatestKey opens a chronological transcript on its newest turn', async () => {
  useMemoryStorage();
  const scroller = await renderInScroller(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout pinLatestKey="pi:s1" />,
    { scrollHeight: 600, clientHeight: 200 },
  );
  // Oldest-first: the newest turn lives at the BOTTOM, so a fresh mount parked
  // at scrollTop 0 would show the oldest response and clip the newest.
  expect(scroller.scrollTop).toBe(600);
});

test.skipIf(!hasDom)('an incoming frame never moves the viewport; a session switch re-pins', async () => {
  useMemoryStorage();
  const scroller = await renderInScroller(
    <MessagesBrowser messages={MESSAGES} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout pinLatestKey="pi:s1" />,
    { scrollHeight: 600, clientHeight: 200 },
  );

  // The captain scrolls back through history, then a live reply arrives.
  await act(async () => {
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event('scroll'));
  });
  const withReply = [...MESSAGES, {
    messageId: 'pane-a:r3', paneId: 'pane-a', piSessionId: 's1', assistantMessageId: 'r3', text: 'Incoming agent response',
  }];
  await act(async () => { root!.render(
    <MessagesBrowser messages={withReply} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout pinLatestKey="pi:s1" />,
  ); });
  expect(scroller.scrollTop).toBe(120);

  // Switching sessions is explicit navigation, so that DOES land on the newest.
  await act(async () => { root!.render(
    <MessagesBrowser messages={withReply} selectedMessageId="pane-a:r2" onSelect={() => {}} chronological chatLayout pinLatestKey="pi:s2" />,
  ); });
  expect(scroller.scrollTop).toBe(600);
});
