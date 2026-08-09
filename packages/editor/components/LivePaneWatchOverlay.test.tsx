/**
 * Mobile DOM coverage for the read-only Watch live overlay.
 *
 * These tests drive the overlay through its PUBLIC stream contract — the same
 * `PaneWatchSubscribe` the real EventSource transport implements — and assert
 * only what a captain can observe on a narrow portrait screen. Nothing here
 * reaches into renderer internals, because the renderer is free to change and
 * the observable promises are not.
 */

import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PaneWatchEvent, PaneWatchStatus } from '@plannotator/core/pane-watch';

import { LivePaneWatchOverlay } from './LivePaneWatchOverlay';
import type { PaneWatchHandlers, PaneWatchSubscribe } from '../live/paneWatchStream';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** iPhone-class portrait viewport: the primary access shape for this feature. */
const NARROW_PORTRAIT_WIDTH = 390;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(node: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

/** A controllable stand-in for the transport, exposing only its public shape. */
function controllableStream(): {
  subscribe: PaneWatchSubscribe;
  emit: (event: PaneWatchEvent) => Promise<void>;
  status: (status: PaneWatchStatus) => Promise<void>;
  unsubscribeCount: () => number;
} {
  let handlers: PaneWatchHandlers | null = null;
  let unsubscribes = 0;
  const subscribe: PaneWatchSubscribe = (_paneId, next) => {
    handlers = next;
    next.onStatus('connecting');
    return () => { unsubscribes++; };
  };
  return {
    subscribe,
    emit: async (event) => { await act(async () => handlers?.onEvent(event)); },
    status: async (status) => { await act(async () => handlers?.onStatus(status)); },
    unsubscribeCount: () => unsubscribes,
  };
}

function frame(ansi: string): PaneWatchEvent {
  return { type: 'frame', paneId: 'w9:p1', ansi, revision: null, truncated: false };
}

async function watching(stream: ReturnType<typeof controllableStream>): Promise<void> {
  await stream.status('watching');
}

async function renderOverlay(
  stream: ReturnType<typeof controllableStream>,
  onClose: () => void = () => {},
): Promise<HTMLDivElement> {
  (window as unknown as { innerWidth: number }).innerWidth = NARROW_PORTRAIT_WIDTH;
  return render(
    <LivePaneWatchOverlay
      paneId="w9:p1"
      paneLabel="firstmate · t3H"
      onClose={onClose}
      subscribe={stream.subscribe}
    />,
  );
}

test.skipIf(!hasDom)('occupies the full dynamic viewport on a narrow portrait screen', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  const overlay = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-overlay"]')!;
  expect(overlay).toBeTruthy();
  // `100dvh`, not `100vh`: mobile browser chrome makes `100vh` overshoot the
  // area the captain can actually see. Asserted as a class rather than an
  // inline style deliberately — happy-dom's CSS parser silently DROPS the
  // `dvh` unit from inline styles, so an inline assertion here would be
  // untestable, and the app's root element already uses this same idiom.
  expect(overlay.className).toContain('h-[100dvh]');
  expect(overlay.className).toContain('h-screen');
  expect(overlay.className).toContain('w-screen');
  expect(overlay.className).toContain('fixed');
  expect(overlay.className).toContain('inset-0');
});

test.skipIf(!hasDom)('shows pane identity and a Close action', async () => {
  const closes: number[] = [];
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => closes.push(1));

  expect(el.querySelector('[data-testid="live-pane-watch-label"]')?.textContent)
    .toBe('firstmate · t3H');

  const close = Array.from(el.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === 'Close')!;
  expect(close).toBeTruthy();
  await act(async () => close.click());
  expect(closes.length).toBe(1);
});

test.skipIf(!hasDom)('terminal text does not wrap and overflow stays reachable', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  await stream.emit(frame(`${'wide-'.repeat(60)}end\nsecond line`));

  const pre = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-frame"]')!;
  expect(pre).toBeTruthy();
  // Wrapping would rearrange a layout the terminal already computed in cells.
  expect(pre.style.whiteSpace).toBe('pre');
  expect(pre.style.overflowWrap).toBe('normal');
  expect(pre.style.wordBreak).toBe('normal');

  // When the floor font size still does not fit, the screen scrolls — in both
  // axes — rather than being reflowed.
  const screen = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-screen"]')!;
  expect(screen.style.overflow).toBe('auto');
});

test.skipIf(!hasDom)('a new frame replaces the previous frame outright', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);

  await stream.emit(frame('first screen'));
  expect(el.textContent).toContain('first screen');

  await stream.emit(frame('second screen'));
  expect(el.textContent).toContain('second screen');
  // Replace, never append: Watch is a view of now, not a scrollback log.
  expect(el.textContent).not.toContain('first screen');
});

test.skipIf(!hasDom)('reconnect removes the stale screen and says Reconnecting…', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  await stream.emit(frame('live output'));
  expect(el.textContent).toContain('live output');

  await stream.status('reconnecting');
  // An old terminal presented as live is worse than no terminal at all.
  expect(el.textContent).not.toContain('live output');
  expect(el.querySelector('[data-testid="live-pane-watch-reconnecting"]')?.textContent)
    .toContain('Reconnecting');
  expect(el.querySelector('[data-testid="live-pane-watch-frame"]')).toBeNull();
});

test.skipIf(!hasDom)('a pane that ended shows Session ended and keeps only Close', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  await stream.emit(frame('output before the pane closed'));

  await stream.status('ended');
  await stream.emit({ type: 'ended', paneId: 'w9:p1', reason: 'pane-gone' });

  expect(el.querySelector('[data-testid="live-pane-watch-ended"]')?.textContent)
    .toBe('Session ended');
  expect(el.textContent).not.toContain('output before the pane closed');

  const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(buttons).toEqual(['Close']);
});

test.skipIf(!hasDom)('renders no input, paste, resize, settings, zoom, or export control', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  await stream.emit(frame('an agent is working here'));

  // Nothing that could accept or forward a keystroke to the pane.
  expect(el.querySelector('input')).toBeNull();
  expect(el.querySelector('textarea')).toBeNull();
  expect(el.querySelector('select')).toBeNull();
  expect(el.querySelector('[contenteditable="true"]')).toBeNull();
  expect(el.querySelector('form')).toBeNull();

  // Close is the ONLY control on the surface.
  const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim());
  expect(buttons).toEqual(['Close']);

  const text = (el.textContent ?? '').toLowerCase();
  for (const forbidden of ['zoom', 'settings', 'export', 'download', 'paste', 'resize', 'restart', 'kill']) {
    expect(text).not.toContain(forbidden);
  }
});

test.skipIf(!hasDom)('closing the overlay releases the watch subscription', async () => {
  const stream = controllableStream();
  await renderOverlay(stream);
  await watching(stream);
  await stream.emit(frame('still running'));
  expect(stream.unsubscribeCount()).toBe(0);

  // Unmounting is what closing does, and it must stop host-side capture.
  await act(async () => root?.unmount());
  root = null;
  expect(stream.unsubscribeCount()).toBe(1);
});
