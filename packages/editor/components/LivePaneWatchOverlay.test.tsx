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

import { LivePaneWatchOverlay, watchFontSize } from './LivePaneWatchOverlay';
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

test.skipIf(!hasDom)('header holds the pane name and Close, and nothing else', async () => {
  const closes: number[] = [];
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => closes.push(1));
  await watching(stream);
  await stream.emit(frame('agent output'));

  expect(el.querySelector('[data-testid="live-pane-watch-label"]')?.textContent)
    .toBe('firstmate · t3H');

  const close = Array.from(el.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === 'Close')!;
  expect(close).toBeTruthy();
  await act(async () => close.click());
  expect(closes.length).toBe(1);

  // Exactly two header items. Read-only is guaranteed by the absence of any
  // control, so a badge saying so would be a third item the presentation
  // contract does not allow — and the sort of thing that creeps back.
  const header = el.querySelector('[data-testid="live-pane-watch-label"]')!.parentElement!;
  const headerText = (header.textContent ?? '').trim();
  expect(headerText).toBe('firstmate · t3HClose');
  expect(headerText.toLowerCase()).not.toContain('read-only');
});

/**
 * The smallest size at which a captain can actually read a terminal on a phone.
 *
 * This is a product floor, not an implementation detail: the deployed overlay
 * rendered a real 215-column pane at 7px, which measured "fit rule working" and
 * looked like an empty black screen. Anything asserting only that the mechanism
 * ran would have passed then too.
 */
const LEGIBLE_MIN_PX = 11;

test('a real desktop-width pane stays legible on a phone rather than shrinking away', () => {
  // The exact shape observed on the deployed service: a 215-column pane in a
  // 390px portrait viewport. The fit rule wants ~3px here, so this is precisely
  // where a floor that is too low stops being a floor and starts being a bug.
  expect(watchFontSize(215, NARROW_PORTRAIT_WIDTH)).toBeGreaterThanOrEqual(LEGIBLE_MIN_PX);

  // Every plausible phone width against every plausible pane width: readability
  // is never traded away, at any combination.
  for (const width of [320, 360, 390, 414, 430]) {
    for (const columns of [80, 120, 160, 215, 300]) {
      expect(watchFontSize(columns, width)).toBeGreaterThanOrEqual(LEGIBLE_MIN_PX);
    }
  }
});

test('narrow content still shrinks only as far as it needs to', () => {
  // The floor must not become a fixed size — content that genuinely fits should
  // still be allowed to size down toward it rather than overflow.
  expect(watchFontSize(40, 390)).toBeGreaterThan(watchFontSize(215, 390) - 1);
  expect(watchFontSize(20, 390)).toBeLessThanOrEqual(13);
});

test.skipIf(!hasDom)('a wide pane renders at a legible size on a narrow portrait screen', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  // 215 columns — the width of the real pane behind the captain's report.
  await stream.emit(frame('x'.repeat(215)));

  const pre = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-frame"]')!;
  const fontPx = Number.parseFloat(pre.style.fontSize);
  expect(fontPx).toBeGreaterThanOrEqual(LEGIBLE_MIN_PX);
});

test.skipIf(!hasDom)('renders every line of a CRLF screen, which is what Herdr sends', async () => {
  // Herdr's visible read terminates EVERY line with `\r\n`. Treating the `\r`
  // as a carriage return that rewrites the line discarded each line an instant
  // before the newline emitted it, so a full agent screen arrived intact on the
  // wire and rendered as a single line. Asserting the RENDERED screen is the
  // point: the frame payload was always correct, so any check on the wire — or
  // on a `\n`-only fixture, as the earlier tests used — passed regardless.
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  const lines = ['first line', 'second line', '', 'fourth line', 'fifth line'];
  await stream.emit(frame(lines.join('\r\n')));

  const rendered = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-frame"]')!.innerText;
  for (const line of lines.filter(Boolean)) {
    expect(rendered).toContain(line);
  }
  expect(rendered.split('\n').filter((line) => line.trim()).length).toBe(4);
});

test.skipIf(!hasDom)('a bare carriage return still rewrites its line', async () => {
  // The CRLF fix must not cost the real behaviour: a `\r` NOT followed by a
  // newline is a genuine carriage return, and a terminal shows what was
  // written after it.
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  await stream.emit(frame('overwritten\rvisible text\r\nsecond line'));

  const rendered = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-frame"]')!.innerText;
  expect(rendered).toContain('visible text');
  expect(rendered).toContain('second line');
  expect(rendered).not.toContain('overwritten');
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
