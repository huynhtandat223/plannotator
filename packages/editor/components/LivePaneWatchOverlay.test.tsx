/**
 * Mobile DOM coverage for the Watch live overlay: a read-only screen with one
 * message composer beneath it.
 *
 * These tests drive the overlay through its PUBLIC contracts — the same
 * `PaneWatchSubscribe` the real EventSource transport implements, and the same
 * send/run callbacks App supplies — and assert only what a captain can observe
 * on a narrow portrait screen. Nothing here reaches into renderer internals,
 * because the renderer is free to change and the observable promises are not.
 *
 * Every overlay rendered here carries the composer, because that is the shape
 * App mounts. A test that omitted the callbacks would still pass every
 * "no input on this surface" assertion below while proving nothing — which is
 * exactly how the read-only assertions this file used to make would have
 * survived the feature that invalidated them.
 */

import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { COMPOSER_BUSY_REASON, COMPOSER_UNREADABLE_REASON, livePaneCapabilityReason } from '@plannotator/core/live-pane-agents';
import type { PaneWatchEvent, PaneWatchStatus } from '@plannotator/core/pane-watch';

import {
  LivePaneWatchOverlay,
  watchCommandBlockedReason,
  watchFontSize,
  watchSendBlockedReason,
} from './LivePaneWatchOverlay';
import type { LivePaneWatchOverlayProps } from './LivePaneWatchOverlay';
import type { LiveDeliveryReceipt } from '../liveResponseFeedback';
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

/** Records every send the overlay makes, and answers with a chosen receipt. */
function recordingSend(
  answer: LiveDeliveryReceipt | Error | (() => Promise<LiveDeliveryReceipt>) = { ok: true, deliveryId: 'd1' } as LiveDeliveryReceipt,
): { send: (text: string) => Promise<LiveDeliveryReceipt>; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: async (text) => {
      sent.push(text);
      if (typeof answer === 'function') return answer();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

async function renderOverlay(
  stream: ReturnType<typeof controllableStream>,
  onClose: () => void = () => {},
  overrides: Partial<LivePaneWatchOverlayProps> = {},
): Promise<HTMLDivElement> {
  (window as unknown as { innerWidth: number }).innerWidth = NARROW_PORTRAIT_WIDTH;
  return render(
    <LivePaneWatchOverlay
      paneId="w9:p1"
      paneLabel="firstmate · t3H"
      // The production default: a Pi pane with a captured session, idle, with a
      // composer wired up.
      agent="pi"
      agentStatus="idle"
      piSessionId="session-1"
      onSendMessage={async () => ({ ok: true, deliveryId: 'd1' } as LiveDeliveryReceipt)}
      onClose={onClose}
      subscribe={stream.subscribe}
      {...overrides}
    />,
  );
}

const inputBox = (el: HTMLElement): HTMLTextAreaElement =>
  el.querySelector<HTMLTextAreaElement>('[data-testid="live-pane-watch-input"]')!;
const sendButton = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('[data-testid="live-pane-watch-send"]')!;
const resultText = (el: HTMLElement): string =>
  el.querySelector<HTMLElement>('[data-testid="live-pane-watch-result"]')?.textContent ?? '';

/** Type into the composer the way a captain does, through the real change event. */
async function type(el: HTMLElement, text: string): Promise<void> {
  const textarea = inputBox(el);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Press a key and report whether the composer claimed it.
 *
 * `defaultPrevented` is the assertable half of "plain Enter inserts a newline":
 * no DOM implementation inserts text for a synthetic keydown, so checking the
 * textarea's value afterwards proves nothing either way. What the composer
 * actually promises is that it does not intercept the key — it leaves the
 * default action to the browser — and that is exactly this.
 */
async function pressEnter(
  el: HTMLElement,
  modifier?: 'metaKey' | 'ctrlKey',
): Promise<{ claimed: boolean }> {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...(modifier ? { [modifier]: true } : {}),
  });
  await act(async () => { inputBox(el).dispatchEvent(event); });
  return { claimed: event.defaultPrevented };
}

async function pressSubmitChord(el: HTMLElement, modifier: 'metaKey' | 'ctrlKey' = 'metaKey'): Promise<void> {
  await pressEnter(el, modifier);
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

/**
 * The observe/control boundary, restated for a surface that now has a write
 * side.
 *
 * The old version of this test asserted the whole overlay had no textarea and
 * exactly one button. That was the right promise while there was nothing to
 * send, and it is the wrong one now — so it is replaced rather than relaxed.
 * What survives untouched is the part that always mattered: the terminal is
 * observed, never driven. The screen region holds no control at all, and the
 * composer below it sends whole messages through a message boundary, not keys.
 */
test.skipIf(!hasDom)('the terminal region stays free of controls; the footer is the only write surface', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => {}, { commands: [{ name: 'handoff-to-continue' }] });
  await watching(stream);
  await stream.emit(frame('an agent is working here'));

  // Nothing inside the screen can accept a keystroke, hold focus, or be clicked.
  const screen = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-screen"]')!;
  expect(screen.querySelector('input')).toBeNull();
  expect(screen.querySelector('textarea')).toBeNull();
  expect(screen.querySelector('select')).toBeNull();
  expect(screen.querySelector('button')).toBeNull();
  expect(screen.querySelector('[contenteditable="true"]')).toBeNull();
  expect(screen.querySelector('[tabindex]')).toBeNull();

  // Every write control lives in the footer, and there is exactly one composer.
  const composer = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-composer"]')!;
  expect(composer).toBeTruthy();
  expect(el.querySelectorAll('textarea').length).toBe(1);
  expect(composer.contains(inputBox(el))).toBe(true);

  // The pane-level affordances a remote terminal would have are still absent —
  // this is a message box, not terminal control.
  const text = (el.textContent ?? '').toLowerCase();
  for (const forbidden of ['zoom', 'settings', 'export', 'download', 'paste', 'resize', 'restart', 'kill', 'send keys', 'ctrl+c']) {
    expect(text).not.toContain(forbidden);
  }
});

test.skipIf(!hasDom)('the footer names the pane, agent, status and delivery mechanism in visible text', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => {}, { agent: 'claude', agentStatus: 'idle', piSessionId: undefined });
  await watching(stream);

  const target = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-target"]')!.textContent ?? '';
  expect(target).toContain('Message this pane');
  expect(target).toContain('firstmate · t3H');
  expect(target).toContain('Claude Code');
  expect(target).toContain('Idle');
  expect(target).toContain("composer");

  // The composer's accessible name identifies the pane too — the visible text
  // is not the only place this is available.
  expect(inputBox(el).getAttribute('aria-label')).toContain('firstmate · t3H');

  // The registry's full composer caveat is shown before anything is sent,
  // verbatim, so the weaker guarantee is visible at decision time.
  const caveat = el.querySelector('[data-testid="live-pane-watch-caveat"]')?.textContent ?? '';
  expect(caveat).toContain('cannot verify which session');
  expect(caveat).toContain('refuses to send while the agent is busy');
});

test.skipIf(!hasDom)('an agent kind with no delivery mechanism stays read-only with the registry reason', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => {}, { agent: 'some-future-agent', piSessionId: undefined });
  await watching(stream);

  // Read-only in the literal sense: nothing to type into, nothing to press.
  expect(el.querySelector('[data-testid="live-pane-watch-input"]')).toBeNull();
  expect(el.querySelector('[data-testid="live-pane-watch-send"]')).toBeNull();
  expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual(['Close']);

  // The exact registry reason, not a generic "not registered" failure.
  expect(el.querySelector('[data-testid="live-pane-watch-blocked"]')?.textContent)
    .toBe(livePaneCapabilityReason('some-future-agent', 'feedback'));
});

test.skipIf(!hasDom)('sends arbitrary multiline prose: plain Enter adds a line, ⌘/Ctrl+Enter sends', async () => {
  const stream = controllableStream();
  const recorder = recordingSend();
  const el = await renderOverlay(stream, () => {}, { onSendMessage: recorder.send });
  await watching(stream);

  const prose = 'Deploy to staging first.\n\nThe token is in 1Password under "staging/api" — 50% of traffic only.';
  await type(el, prose);

  // Plain Enter is the newline key, so the composer must not claim it: it
  // neither cancels the browser's default action nor sends. This is prose, and
  // prose has paragraphs.
  const plain = await pressEnter(el);
  expect(plain.claimed).toBe(false);
  expect(recorder.sent).toEqual([]);
  expect(inputBox(el).value).toBe(prose);

  // The chord is claimed — otherwise it would send AND insert a newline.
  const chord = await pressEnter(el, 'metaKey');
  expect(chord.claimed).toBe(true);
  // Multiline prose, blank lines, quotes, an em dash and a % all survive intact.
  expect(recorder.sent).toEqual([prose]);
});

test.skipIf(!hasDom)('the exact text is sent — trimming decides only whether there is anything to send', async () => {
  const stream = controllableStream();
  const recorder = recordingSend();
  const el = await renderOverlay(stream, () => {}, { onSendMessage: recorder.send });
  await watching(stream);

  // Whitespace-only is nothing to send, and says so without calling the host.
  await type(el, '   \n  ');
  await act(async () => sendButton(el).click());
  expect(recorder.sent).toEqual([]);
  expect(resultText(el)).toContain('Type a message first');

  // Otherwise the captain's bytes go out untouched: leading indentation in a
  // pasted snippet is content, not slop to be tidied away.
  const snippet = '  const timeout = 30\n  retries = 2\n';
  await type(el, snippet);
  await act(async () => sendButton(el).click());
  expect(recorder.sent).toEqual([snippet]);
});

test.skipIf(!hasDom)('Ctrl+Enter sends too, for the captains not on a Mac', async () => {
  const stream = controllableStream();
  const recorder = recordingSend();
  const el = await renderOverlay(stream, () => {}, { onSendMessage: recorder.send });
  await watching(stream);
  await type(el, 'run the migration');
  await pressSubmitChord(el, 'ctrlKey');
  expect(recorder.sent).toEqual(['run the migration']);
});

test.skipIf(!hasDom)('on extension delivery, a message beginning with / is literal text, never a command', async () => {
  const stream = controllableStream();
  const recorder = recordingSend();
  const ran: string[] = [];
  const el = await renderOverlay(stream, () => {}, {
    onSendMessage: recorder.send,
    onRunCommand: async (name) => { ran.push(name); },
    commands: [{ name: 'compact' }],
  });
  await watching(stream);

  await type(el, '/compact is not what I mean — please compact the migration files instead');
  await act(async () => sendButton(el).click());

  expect(recorder.sent).toEqual(['/compact is not what I mean — please compact the migration files instead']);
  // The advertised command of the same name was never invoked.
  expect(ran).toEqual([]);
});

test.skipIf(!hasDom)('on composer delivery, text starting with / is refused as it is typed', async () => {
  // Observed on a real Claude Code pane: `/model` was typed in, Enter #1 took
  // the completion popup, Enter #2 submitted, and because the picker it opened
  // starts no turn, Enter #3 confirmed the picker. The composer cannot offer
  // this text at all, and must say so before a message is written around it.
  const stream = controllableStream();
  const recorder = recordingSend();
  const input = recordingPaneInput();
  const el = await renderOverlay(stream, () => {}, {
    agent: 'claude',
    agentStatus: 'idle',
    piSessionId: undefined,
    onSendMessage: recorder.send,
    onPaneInput: input.send,
  });
  await watching(stream);

  await type(el, '/model');

  const reason = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-draft-blocked"]')?.textContent ?? '';
  expect(reason).toContain('Nothing was typed');
  expect(reason).toContain('commands control');
  expect(sendButton(el).disabled).toBe(true);

  // The chord bypasses the button entirely, so it is re-checked in the handler.
  await pressSubmitChord(el, 'metaKey');
  expect(recorder.sent).toEqual([]);
  // A refusal never costs the captain their text.
  expect(inputBox(el).value).toBe('/model');

  // Clicking anyway reports the same reason rather than failing silently.
  await act(async () => sendButton(el).click());
  expect(recorder.sent).toEqual([]);

  // The refusal names a route, so the route must be on screen. Taking it types
  // the very same text — the difference is that nothing presses Enter.
  expect(el.querySelector('[data-testid="live-pane-watch-typing"]')).toBeTruthy();
  await act(async () => typeButton(el).click());
  expect(input.events).toEqual(['text:/model']);
  expect(recorder.sent).toEqual([]);
});

/** Records raw pane input in arrival order — the property that matters most. */
function recordingPaneInput() {
  const events: string[] = [];
  return {
    events,
    send: async (event: { kind: 'text'; text: string } | { kind: 'key'; key: string }) => {
      events.push(event.kind === 'text' ? `text:${event.text}` : `key:${event.key}`);
    },
  };
}

const typeButton = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('[data-testid="live-pane-watch-type"]')!;
const keyButton = (el: HTMLElement, key: string): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>(`[data-testid="live-pane-watch-key-${key}"]`)!;

test.skipIf(!hasDom)('typing into the pane presses nothing, and the keys are separate deliberate presses', async () => {
  // The `/model` interaction end to end: the characters land in the agent's own
  // composer, its native popup opens (visible in the screen above, not modelled
  // here), and the captain drives it. Nothing is pressed on their behalf —
  // which is exactly what the Send message path cannot promise.
  const stream = controllableStream();
  const input = recordingPaneInput();
  const el = await renderOverlay(stream, () => {}, {
    agent: 'claude',
    agentStatus: 'idle',
    piSessionId: undefined,
    onPaneInput: input.send,
  });
  await watching(stream);

  await type(el, '/mod');
  await act(async () => typeButton(el).click());
  // Typed, and NOT submitted: no key event accompanies the text.
  expect(input.events).toEqual(['text:/mod']);
  // The pane's composer now holds it, so this box hands over authority.
  expect(inputBox(el).value).toBe('');
  expect(el.querySelector('[data-testid="live-pane-watch-type-result"]')?.textContent)
    .toContain('Nothing was submitted');

  await act(async () => keyButton(el, 'tab').click());
  await act(async () => keyButton(el, 'enter').click());
  // One press per click, in order, and never coalesced or repeated.
  expect(input.events).toEqual(['text:/mod', 'key:tab', 'key:enter']);
});

test.skipIf(!hasDom)('a key press is never retried, and never doubled by a second click in flight', async () => {
  // A key that may already have landed must not be pressed again on
  // Plannotator's initiative — including by the captain's own double tap.
  const stream = controllableStream();
  const events: string[] = [];
  let release: (() => void) | null = null;
  const el = await renderOverlay(stream, () => {}, {
    agent: 'claude',
    agentStatus: 'idle',
    piSessionId: undefined,
    onPaneInput: async (event) => {
      events.push(event.kind === 'key' ? event.key : 'text');
      await new Promise<void>((resolve) => { release = resolve; });
    },
  });
  await watching(stream);

  await act(async () => keyButton(el, 'enter').click());
  expect(keyButton(el, 'enter').disabled).toBe(true);
  await act(async () => keyButton(el, 'enter').click());
  expect(events).toEqual(['enter']);

  await act(async () => { release?.(); });
  expect(keyButton(el, 'enter').disabled).toBe(false);
});

test.skipIf(!hasDom)('a failed key reports the failure and offers no retry affordance', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => {}, {
    agent: 'claude',
    agentStatus: 'idle',
    piSessionId: undefined,
    onPaneInput: async () => { throw new Error('That pane is no longer live.'); },
  });
  await watching(stream);

  await act(async () => keyButton(el, 'tab').click());
  const result = el.querySelector<HTMLElement>('[data-testid="live-pane-watch-type-result"]')!;
  expect(result.textContent).toContain('That pane is no longer live.');
  // No "try again" button appears: re-pressing is the captain's call, made by
  // pressing the key again after looking at the screen.
  expect(result.querySelector('button')).toBeNull();
});

test.skipIf(!hasDom)('raw typing is pane-scoped: an agent kind with no delivery mechanism still gets it', async () => {
  // Herdr can type into any pane it manages. Gating this on Plannotator's
  // feedback capability would make the newest agent kind the least usable one.
  const stream = controllableStream();
  const input = recordingPaneInput();
  const el = await renderOverlay(stream, () => {}, {
    agent: 'some-future-agent',
    piSessionId: undefined,
    onPaneInput: input.send,
  });
  await watching(stream);

  // No assured-send affordance — that one really is unavailable for this kind.
  expect(el.querySelector('[data-testid="live-pane-watch-send"]')).toBeNull();
  // But there is a box, and it reaches the pane.
  await type(el, '/help');
  await act(async () => typeButton(el).click());
  expect(input.events).toEqual(['text:/help']);
});

test.skipIf(!hasDom)('composer delivery still sends prose that merely contains a slash', async () => {
  // The hazard is the agent's completion popup, which opens only on the first
  // character. Refusing more than that would censor paths, dates and URLs.
  const stream = controllableStream();
  const recorder = recordingSend();
  const el = await renderOverlay(stream, () => {}, {
    agent: 'claude',
    agentStatus: 'idle',
    piSessionId: undefined,
    onSendMessage: recorder.send,
  });
  await watching(stream);

  const prose = 'check src/app.ts — /model is worth a look, and 1/2 the diff is noise';
  await type(el, prose);
  expect(el.querySelector('[data-testid="live-pane-watch-draft-blocked"]')).toBeNull();
  expect(sendButton(el).disabled).toBe(false);
  await act(async () => sendButton(el).click());
  expect(recorder.sent).toEqual([prose]);
});

test.skipIf(!hasDom)('a successful send clears the draft; a refusal keeps it', async () => {
  const stream = controllableStream();
  let answer: LiveDeliveryReceipt | Error = new Error('The selected Pi pane session is no longer current');
  const el = await renderOverlay(stream, () => {}, {
    onSendMessage: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  await watching(stream);

  await type(el, 'the api key is in the vault');
  await act(async () => sendButton(el).click());
  // A refusal must never cost the captain their message.
  expect(inputBox(el).value).toBe('the api key is in the vault');
  expect(resultText(el)).toContain('no longer current');

  answer = { ok: true, deliveryId: 'd1' } as LiveDeliveryReceipt;
  await act(async () => sendButton(el).click());
  expect(inputBox(el).value).toBe('');
});

test.skipIf(!hasDom)('Send is disabled in flight, so one message cannot become two', async () => {
  const stream = controllableStream();
  const sent: string[] = [];
  let release: (() => void) | null = null;
  const el = await renderOverlay(stream, () => {}, {
    onSendMessage: async (text) => {
      sent.push(text);
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, deliveryId: 'd1' } as LiveDeliveryReceipt;
    },
  });
  await watching(stream);
  await type(el, 'restart the worker');

  await act(async () => { sendButton(el).click(); });
  expect(sendButton(el).disabled).toBe(true);

  // Everything a determined captain can do during the round trip.
  await act(async () => { sendButton(el).click(); });
  await pressSubmitChord(el);
  expect(sent).toEqual(['restart the worker']);

  await act(async () => { release?.(); });
  expect(sendButton(el).disabled).toBe(false);
});

test.skipIf(!hasDom)('an extension send is reported as queued — never received or delivered', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => {}, {
    agent: 'pi',
    onSendMessage: async () => ({ ok: true, deliveryId: 'd1' } as LiveDeliveryReceipt),
  });
  await watching(stream);
  await type(el, 'use the staging database');
  await act(async () => sendButton(el).click());

  const result = resultText(el).toLowerCase();
  expect(result).toContain('queued');
  // The host reports a queue entry and nothing else; the claim happens out of
  // band. Any stronger word here would be a receipt we do not have.
  expect(result).not.toContain('received');
  expect(result).not.toContain('delivered.');
});

test.skipIf(!hasDom)('a confirmed composer send says a turn started; an unconfirmed one warns and offers no retry', async () => {
  const stream = controllableStream();
  let receipt: LiveDeliveryReceipt = { mechanism: 'herdr-composer', confirmed: true };
  const sent: string[] = [];
  const el = await renderOverlay(stream, () => {}, {
    agent: 'claude',
    agentStatus: 'idle',
    piSessionId: undefined,
    onSendMessage: async (text) => { sent.push(text); return receipt; },
  });
  await watching(stream);

  await type(el, 'the flag is behind LD');
  await act(async () => sendButton(el).click());
  expect(resultText(el)).toContain('started a turn');

  receipt = { mechanism: 'herdr-composer', confirmed: false, note: 'no turn start was observed' };
  await type(el, 'and the rollout is 10%');
  await act(async () => sendButton(el).click());
  expect(resultText(el).toLowerCase()).toContain('unconfirmed');
  expect(resultText(el)).toContain('no turn start was observed');

  // No automatic resend and no retry affordance: retyping is how a message
  // gets delivered twice, and the host cannot take one back.
  expect(sent).toEqual(['the flag is behind LD', 'and the rollout is 10%']);
  const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim().toLowerCase() ?? '');
  expect(buttons.some((label) => label.includes('retry') || label.includes('resend'))).toBe(false);
});

test.skipIf(!hasDom)('a busy or unreadable composer pane is refused before any request is made', async () => {
  for (const [status, reason] of [
    ['working', COMPOSER_BUSY_REASON],
    ['blocked', COMPOSER_BUSY_REASON],
    ['unknown', COMPOSER_UNREADABLE_REASON],
  ] as const) {
    const stream = controllableStream();
    const recorder = recordingSend();
    const el = await renderOverlay(stream, () => {}, {
      agent: 'codex',
      agentStatus: status,
      piSessionId: undefined,
      onSendMessage: recorder.send,
    });
    await watching(stream);

    expect(el.querySelector('[data-testid="live-pane-watch-blocked"]')?.textContent).toBe(reason);
    expect(sendButton(el).disabled).toBe(true);

    await type(el, 'check the migration');
    await pressSubmitChord(el);
    // Nothing was typed into the pane, so nothing needs checking there.
    expect(recorder.sent).toEqual([]);
    expect(inputBox(el).value).toBe('check the migration');

    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  }
});

test.skipIf(!hasDom)('a replaced session refuses both writing and running, and keeps the draft', async () => {
  const stream = controllableStream();
  const recorder = recordingSend();
  const ran: string[] = [];
  const el = await renderOverlay(stream, () => {}, {
    sessionReplaced: true,
    commands: [{ name: 'handoff-to-continue' }],
    onSendMessage: recorder.send,
    onRunCommand: async (name) => { ran.push(name); },
  });
  await watching(stream);

  await type(el, 'the deploy key rotated');
  await pressSubmitChord(el);
  expect(recorder.sent).toEqual([]);
  expect(inputBox(el).value).toBe('the deploy key rotated');
  expect(el.querySelector('[data-testid="live-pane-watch-blocked"]')?.textContent)
    .toContain('replaced since Watch opened');

  // The captured command list belongs to the session that advertised it, so it
  // must not be runnable against its replacement either.
  const run = el.querySelector<HTMLButtonElement>('[data-testid="live-pane-watch-run-command"]')!;
  expect(run.disabled).toBe(true);
  await act(async () => run.click());
  expect(ran).toEqual([]);
});

test.skipIf(!hasDom)('commands are advertised-only, explicit, and never triggered by selection alone', async () => {
  const stream = controllableStream();
  const ran: string[] = [];
  const recorder = recordingSend();
  const el = await renderOverlay(stream, () => {}, {
    commands: [{ name: 'handoff-to-continue', description: 'Hand off to a fresh session' }],
    onRunCommand: async (name) => { ran.push(name); },
    onSendMessage: recorder.send,
  });
  await watching(stream);

  const select = el.querySelector<HTMLSelectElement>('[data-testid="live-pane-watch-command-select"]')!;
  // Only what the pane advertised, plus the empty choice.
  expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'handoff-to-continue']);

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'handoff-to-continue');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Choosing is not running.
  expect(ran).toEqual([]);

  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="live-pane-watch-run-command"]')!.click());
  expect(ran).toEqual(['handoff-to-continue']);
  // A command receipt is not a message receipt.
  const commandResult = el.querySelector('[data-testid="live-pane-watch-command-result"]')?.textContent ?? '';
  expect(commandResult).toContain('Command started');
  // …and running one sent no message.
  expect(recorder.sent).toEqual([]);
});

test.skipIf(!hasDom)('advertised commands without a captured session are visibly refused, not run unpinned', async () => {
  // The host reads a command request WITHOUT a sessionId as "resolve the
  // current registration" — the deliberate opt-out for callers that pick a
  // command at click time. Watch is not one of those, so a missing captured
  // session must disable the action rather than quietly become the unpinned
  // path and run against whichever session happens to be registered.
  const stream = controllableStream();
  const ran: string[] = [];
  const el = await renderOverlay(stream, () => {}, {
    piSessionId: undefined,
    commands: [{ name: 'handoff-to-continue' }],
    onRunCommand: async (name) => { ran.push(name); },
  });
  await watching(stream);

  expect(el.querySelector('[data-testid="live-pane-watch-command-blocked"]')?.textContent)
    .toContain('did not capture the agent session that advertised these commands');

  const select = el.querySelector<HTMLSelectElement>('[data-testid="live-pane-watch-command-select"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'handoff-to-continue');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const run = el.querySelector<HTMLButtonElement>('[data-testid="live-pane-watch-run-command"]')!;
  expect(run.disabled).toBe(true);
  await act(async () => run.click());
  expect(ran).toEqual([]);
});

test('the command gate requires a captured session, then rejects a replaced one', () => {
  expect(watchCommandBlockedReason({ piSessionId: undefined }))
    .toContain('did not capture the agent session');
  expect(watchCommandBlockedReason({ piSessionId: 'session-1', sessionReplaced: true }))
    .toContain('replaced since Watch opened');
  expect(watchCommandBlockedReason({ piSessionId: 'session-1' })).toBeNull();
});

test.skipIf(!hasDom)('a kind that advertises no commands gets no command control at all', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream, () => {}, {
    agent: 'claude',
    agentStatus: 'idle',
    piSessionId: undefined,
    commands: [{ name: 'somehow-advertised' }],
    onRunCommand: async () => {},
  });
  await watching(stream);

  // Claude Code advertises no Plannotator commands, so the capability — not a
  // stray list — decides whether the control exists.
  expect(el.querySelector('[data-testid="live-pane-watch-commands"]')).toBeNull();
  expect(el.querySelector('select')).toBeNull();
});

test.skipIf(!hasDom)('an ended pane keeps Close and takes the composer away with the screen', async () => {
  const stream = controllableStream();
  const el = await renderOverlay(stream);
  await watching(stream);
  await stream.emit(frame('output before the pane closed'));
  expect(el.querySelector('[data-testid="live-pane-watch-composer"]')).toBeTruthy();

  await stream.status('ended');
  await stream.emit({ type: 'ended', paneId: 'w9:p1', reason: 'pane-gone' });

  // A composer under a dead pane offers something that cannot happen.
  expect(el.querySelector('[data-testid="live-pane-watch-composer"]')).toBeNull();
  expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual(['Close']);
});

test('the send gate reports the most permanent reason first', () => {
  // A kind that can never be messaged must not be told to wait for it to go
  // idle, and a replaced session outranks a transient busy state.
  expect(watchSendBlockedReason({ agent: 'some-future-agent', agentStatus: 'idle' }))
    .toBe(livePaneCapabilityReason('some-future-agent', 'feedback'));
  expect(watchSendBlockedReason({ agent: 'claude', agentStatus: 'working', sessionReplaced: true }))
    .toContain('replaced since Watch opened');
  expect(watchSendBlockedReason({ agent: 'pi', agentStatus: 'idle', piSessionId: undefined }))
    .toContain('did not capture an agent session');
  // A Pi pane is not gated on agent state: its extension queue is session-exact
  // and does not type into a composer, so a busy Pi pane can still be messaged.
  expect(watchSendBlockedReason({ agent: 'pi', agentStatus: 'working', piSessionId: 'session-1' })).toBeNull();
  expect(watchSendBlockedReason({ agent: 'claude', agentStatus: 'idle' })).toBeNull();
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
