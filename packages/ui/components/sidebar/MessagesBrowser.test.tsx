import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MessagesBrowser,
  MESSAGE_PAGE_STEP,
  anchoredScrollTop,
  anchoredScrollTopForGrowth,
  anchoredScrollTopForRowShift,
  isNearHistoryEdge,
  resolveRowBudget,
} from './MessagesBrowser';
import { resetStorageBackend, setStorageBackend, setMessagePickerCount } from '../../utils/storage';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** In-memory storage so the picker-count default is deterministic per test. */
function useMemoryStorage(): void {
  const store = new Map<string, string>();
  setStorageBackend({
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetStorageBackend();
});

test.skipIf(!hasDom)('renders an accessible chronological response picker with a selected newest response', async () => {
  useMemoryStorage();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser
      chronological
      messages={[
        { messageId: 'm1', text: 'Oldest response' },
        { messageId: 'm2', text: 'Newest response' },
      ]}
      selectedMessageId="m2"
      onSelect={() => {}}
    />);
  });

  expect(host.textContent).toContain('Recent responses — oldest first');
  const rows = host.querySelectorAll('button');
  // 2 message rows, no "Show older" toggle (default count 3 > 2 messages).
  expect(rows).toHaveLength(2);
  const selected = host.querySelector('[aria-current="true"]');
  expect(selected).not.toBeNull();
  expect(selected!.getAttribute('aria-pressed')).toBe('true');
  expect(selected!.textContent).toContain('Newest response');
});

test.skipIf(!hasDom)('collapses to the default quota and pages incrementally', async () => {
  useMemoryStorage();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const messages = Array.from({ length: 6 }, (_, i) => ({
    messageId: `m${i + 1}`,
    text: `Response ${i + 1}`,
  }));
  await act(async () => {
    root!.render(<MessagesBrowser messages={messages} selectedMessageId="m1" onSelect={() => {}} />);
  });

  // Default quota is 3 → 3 rows shown + one `+N more` pager.
  const pager = Array.from(host.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('more'),
  );
  expect(pager).toBeTruthy();
  expect(pager!.textContent).toContain('+3 more');
  expect(host.textContent).toContain('Response 3');
  expect(host.textContent).not.toContain('Response 4');

  // Paging is incremental, not all-or-nothing: one click reveals the page step.
  await act(async () => {
    pager!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(host.textContent).toContain('Response 6');
  expect(host.textContent).toContain('Show fewer');
});

test.skipIf(!hasDom)('clusters pane-grouped rows under herd/workspace section headers', async () => {
  useMemoryStorage();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser
      messages={[
        { messageId: 'a1', text: 'alpha resp', paneId: 'p1', paneLabel: 'alpha-herd', workspaceId: 'ws-a' },
        { messageId: 'b1', text: 'beta resp', paneId: 'p2', paneLabel: 'beta-herd', workspaceId: 'ws-b' },
        { messageId: 'a2', text: 'alpha resp 2', paneId: 'p3', paneLabel: 'alpha-herd', workspaceId: 'ws-a' },
      ]}
      selectedMessageId="a1"
      onSelect={() => {}}
    />);
  });

  // Two distinct herds → two section headers, first-seen order preserved.
  const headers = Array.from(host.querySelectorAll('div')).filter((el) =>
    el.children.length === 0 && /herd$/.test((el.textContent ?? '').trim()),
  );
  const headerText = headers.map((el) => (el.textContent ?? '').trim());
  expect(headerText).toContain('alpha-herd');
  expect(headerText).toContain('beta-herd');
  // The repeated workspace name is a section header now, not inline per row.
  expect(headerText.filter((t) => t === 'alpha-herd')).toHaveLength(1);
});

test.skipIf(!hasDom)('caps the visible count independently for sessions in the same workspace', async () => {
  useMemoryStorage();
  setMessagePickerCount('1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser
      messages={[
        { messageId: 'a1', text: 'session alpha latest', paneId: 'p1', piSessionId: 'session-a', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
        { messageId: 'a2', text: 'session alpha older', paneId: 'p1', piSessionId: 'session-a', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
        { messageId: 'b1', text: 'session beta latest', paneId: 'p2', piSessionId: 'session-b', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
        { messageId: 'b2', text: 'session beta older', paneId: 'p2', piSessionId: 'session-b', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
      ]}
      selectedMessageId="a1"
      onSelect={() => {}}
    />);
  });

  expect(host.textContent).toContain('session alpha latest');
  expect(host.textContent).toContain('session beta latest');
  expect(host.textContent).not.toContain('session alpha older');
  expect(host.textContent).not.toContain('session beta older');
  expect(host.textContent).toContain('+2 more');
});

test.skipIf(!hasDom)('falls back to pane identity and expands all hidden session responses', async () => {
  useMemoryStorage();
  setMessagePickerCount('1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser
      messages={[
        { messageId: 'a1', text: 'pane alpha latest', paneId: 'p1', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
        { messageId: 'a2', text: 'pane alpha older', paneId: 'p1', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
        { messageId: 'b1', text: 'pane beta latest', paneId: 'p2', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
        { messageId: 'b2', text: 'pane beta older', paneId: 'p2', paneLabel: 'shared-herd', workspaceId: 'ws-a' },
      ]}
      selectedMessageId="a1"
      onSelect={() => {}}
    />);
  });

  expect(host.textContent).toContain('pane alpha latest');
  expect(host.textContent).toContain('pane beta latest');
  expect(host.textContent).not.toContain('pane alpha older');
  expect(host.textContent).not.toContain('pane beta older');
  const toggle = Array.from(host.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes('+2 more'),
  );
  expect(toggle).toBeTruthy();

  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(host.textContent).toContain('pane alpha older');
  expect(host.textContent).toContain('pane beta older');
  const showFewer = Array.from(host.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes('Show fewer'),
  );
  expect(showFewer).toBeTruthy();

  await act(async () => {
    showFewer!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(host.textContent).not.toContain('pane alpha older');
  expect(host.textContent).not.toContain('pane beta older');
});

test.skipIf(!hasDom)('keeps the global count for non-live message lists', async () => {
  useMemoryStorage();
  setMessagePickerCount('1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser
      messages={[
        { messageId: 'm1', text: 'flat latest' },
        { messageId: 'm2', text: 'flat older' },
      ]}
      selectedMessageId="m1"
      onSelect={() => {}}
    />);
  });

  expect(host.textContent).toContain('flat latest');
  expect(host.textContent).not.toContain('flat older');
  expect(host.textContent).toContain('+1 more');
});

test.skipIf(!hasDom)('renders an accessible empty response state', async () => {
  useMemoryStorage();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser messages={[]} selectedMessageId={null} onSelect={() => {}} />);
  });

  expect(host.textContent).toContain('No recent assistant messages found.');
});

test.skipIf(!hasDom)('offers only per-pane quotas the host can satisfy, with no inert 10', async () => {
  useMemoryStorage();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser
      messages={[{ messageId: 'm1', text: 'only' }]}
      selectedMessageId="m1"
      onSelect={() => {}}
    />);
  });

  const select = host.querySelector('select');
  expect(select).not.toBeNull();
  // The label must state the per-pane truth rather than a vague "Show".
  expect(select!.getAttribute('aria-label')).toBe('Responses to show per pane');
  expect(host.textContent).toContain('Per pane:');
  const options = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
  expect(options).toEqual(['1', '3', '5', 'All']);
  expect(options).not.toContain('10');
});

test.skipIf(!hasDom)('keeps paging progress when the per-pane quota changes', async () => {
  useMemoryStorage();
  setMessagePickerCount('1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const messages = Array.from({ length: 9 }, (_, i) => ({
    messageId: `m${i + 1}`,
    text: `Response ${i + 1}`,
  }));
  await act(async () => {
    root!.render(<MessagesBrowser messages={messages} selectedMessageId="m1" onSelect={() => {}} />);
  });

  // Quota 1 → one row, rest paged.
  expect(host.textContent).toContain('Response 1');
  expect(host.textContent).not.toContain('Response 2');

  const more = Array.from(host.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('more'),
  );
  await act(async () => {
    more!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // 1 quota + 5 paged = 6 rows.
  expect(host.textContent).toContain('Response 6');
  expect(host.textContent).not.toContain('Response 7');

  // Raising the quota must COMPOSE with paging, not reset it: 3 + 5 = 8.
  const select = host.querySelector('select')!;
  await act(async () => {
    select.value = '3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('Response 8');
  expect(host.textContent).not.toContain('Response 9');
});

test.skipIf(!hasDom)('treats All as absolute regardless of paging', async () => {
  useMemoryStorage();
  setMessagePickerCount('all');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const messages = Array.from({ length: 7 }, (_, i) => ({
    messageId: `m${i + 1}`,
    text: `Response ${i + 1}`,
  }));
  await act(async () => {
    root!.render(<MessagesBrowser messages={messages} selectedMessageId="m1" onSelect={() => {}} />);
  });

  expect(host.textContent).toContain('Response 7');
  // Nothing is hidden, so no paging affordance should be offered at all.
  expect(host.textContent).not.toContain('more');
});

test.skipIf(!hasDom)('auto-pages older chronological history on scroll and keeps the reader anchored', async () => {
  useMemoryStorage();
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  host = document.createElement('div');
  scroller.append(host);
  document.body.append(scroller);
  let scrollHeight = 520;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  });
  scroller.scrollTop = 180;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 300, width: 300, height: 300, x: 0, y: 0, toJSON() {} });

  const messages = Array.from({ length: 12 }, (_, i) => ({
    messageId: `m${i + 1}`,
    text: `Response ${i + 1}`,
  }));
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser chronological autoLoadOnScroll messages={messages} selectedMessageId="m12" onSelect={() => {}} />);
  });
  expect(host.textContent).not.toContain('Response 5');

  scroller.scrollTop = 40;
  await act(async () => {
    scroller.dispatchEvent(new Event('scroll'));
    scrollHeight = 720;
  });

  expect(host.textContent).toContain('Response 5');
  // Five older rows were prepended (+200px in this synthetic layout), so the
  // same visible row remains under the reader instead of jumping upward.
  expect(scroller.scrollTop).toBe(240);
});

test.skipIf(!hasDom)('Jump to latest reliably targets the chronological newest row', async () => {
  useMemoryStorage();
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  host = document.createElement('div');
  scroller.append(host);
  document.body.append(scroller);
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 500 },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON() {} });
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser chronological messages={[
      { messageId: 'm1', text: 'Oldest response' },
      { messageId: 'm2', text: 'Newest response' },
    ]} selectedMessageId="m2" onSelect={() => {}} />);
  });
  const newest = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('Newest response'))!;
  newest.getBoundingClientRect = () => ({ top: 420, bottom: 470, left: 0, right: 280, width: 280, height: 50, x: 0, y: 420, toJSON() {} });
  const calls: ScrollIntoViewOptions[] = [];
  newest.scrollIntoView = (options) => calls.push(options as ScrollIntoViewOptions);

  await act(async () => {
    scroller.dispatchEvent(new Event('scroll'));
  });
  // The selection is already the newest row here, so the control on offer is
  // the pure SCROLL one. Its label says so: the pair of near-identical
  // "Jump to latest" / "Back to latest" buttons that could both render at once
  // is now one control that states its own effect.
  const jump = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Scroll to newest');
  expect(jump).toBeTruthy();
  // And only one of the two ever renders.
  expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Open newest response')).toBe(false);
  await act(async () => {
    jump!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(calls).toEqual([{ block: 'end', behavior: 'smooth' }]);
});

test.skipIf(!hasDom)('external new-replies jump signal targets the latest chronological row without selecting it', async () => {
  useMemoryStorage();
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  host = document.createElement('div');
  scroller.append(host);
  document.body.append(scroller);
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 500 },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON() {} });
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser chronological jumpToLatestSignal={0} messages={[
      { messageId: 'm1', text: 'Oldest response' },
      { messageId: 'm2', text: 'Newest response' },
    ]} selectedMessageId="m1" onSelect={() => {}} />);
  });
  const newest = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('Newest response'))!;
  const calls: ScrollIntoViewOptions[] = [];
  newest.scrollIntoView = (options) => calls.push(options as ScrollIntoViewOptions);
  await act(async () => {
    root!.render(<MessagesBrowser chronological jumpToLatestSignal={1} messages={[
      { messageId: 'm1', text: 'Oldest response' },
      { messageId: 'm2', text: 'Newest response' },
    ]} selectedMessageId="m1" onSelect={() => {}} />);
  });
  expect(calls).toEqual([{ block: 'end', behavior: 'smooth' }]);
  expect(host.querySelector('[aria-current="true"]')?.textContent).toContain('Oldest response');
});

test('detects the history edge for both list orderings', () => {
  const metrics = { scrollTop: 40, scrollHeight: 1000, clientHeight: 300 };
  expect(isNearHistoryEdge(metrics, true)).toBe(true);
  expect(isNearHistoryEdge(metrics, false)).toBe(false);
  expect(isNearHistoryEdge({ ...metrics, scrollTop: 650 }, false)).toBe(true);
});

test('anchors the viewport so an incoming SSE frame never scrolls the reader', () => {
  // A reader parked mid-list: the list grows above them by 120px, so the
  // anchor must add exactly that back to keep the same rows on screen.
  expect(anchoredScrollTop({ scrollTop: 400, scrollHeight: 1000 }, 1120)).toBe(520);
  // Shrinking (a pane closed) must not leave a gap past the new bottom.
  expect(anchoredScrollTop({ scrollTop: 400, scrollHeight: 1000 }, 900)).toBe(300);
  // No height change → no movement.
  expect(anchoredScrollTop({ scrollTop: 400, scrollHeight: 1000 }, 1000)).toBe(400);
  // A reader at the top is "following latest"; moving them would BE the bug.
  expect(anchoredScrollTop({ scrollTop: 0, scrollHeight: 1000 }, 1400)).toBe(0);
  // Compensation can never scroll to a negative offset.
  expect(anchoredScrollTop({ scrollTop: 40, scrollHeight: 1000 }, 200)).toBe(0);
});

test('compensates only the growth that lands above the viewport', () => {
  const parked = { scrollTop: 400, scrollHeight: 1000 };
  // Oldest-first `+N more`: history is prepended ABOVE the reader, so they are
  // pushed down by exactly that much — including from the very top, where they
  // are sitting ON the history edge and would otherwise be thrown backwards.
  expect(anchoredScrollTopForGrowth(parked, 1300, 'page-prepend')).toBe(700);
  expect(anchoredScrollTopForGrowth({ scrollTop: 0, scrollHeight: 1000 }, 1300, 'page-prepend')).toBe(300);
  // Newest-first `+N more`: history is appended BELOW the reader. Nothing above
  // them moved, so any compensation would itself scroll them off their place.
  expect(anchoredScrollTopForGrowth(parked, 1300, 'page-append')).toBe(400);
  expect(anchoredScrollTopForGrowth(parked, 700, 'page-append')).toBe(400);
  // A live frame keeps the existing SSE anchor, top-parked exemption included.
  expect(anchoredScrollTopForGrowth(parked, 1120, 'live')).toBe(520);
  expect(anchoredScrollTopForGrowth({ scrollTop: 0, scrollHeight: 1000 }, 1400, 'live')).toBe(0);
});

test('anchors on a real row, because a windowed list barely changes height', () => {
  // The budget keeps a fixed row count, so a prepended live turn also evicts
  // one off the far end: total height moves by ~0 while every visible row
  // slides down a slot. Only measuring a surviving row catches that.
  expect(anchoredScrollTopForRowShift({ scrollTop: 240 }, 82, 'live')).toBe(322);
  expect(anchoredScrollTopForRowShift({ scrollTop: 240 }, -82, 'live')).toBe(158);
  // Both growth-anchor exemptions survive: top-parked is following the latest,
  // and appended history below the viewport never moves the reader.
  expect(anchoredScrollTopForRowShift({ scrollTop: 0 }, 82, 'live')).toBe(0);
  expect(anchoredScrollTopForRowShift({ scrollTop: 240 }, 82, 'page-append')).toBe(240);
  // A prepended page DOES move a top-parked reader — they sit on the edge it
  // was inserted at, so leaving them would throw them back into history.
  expect(anchoredScrollTopForRowShift({ scrollTop: 0 }, 300, 'page-prepend')).toBe(300);
  // Never past the top of the list.
  expect(anchoredScrollTopForRowShift({ scrollTop: 40 }, -300, 'live')).toBe(0);
});

test('composes the row budget from the quota plus paged rows', () => {
  expect(resolveRowBudget('3', 0)).toBe(3);
  // Paging is additive to the quota, never a replacement for it.
  expect(resolveRowBudget('3', MESSAGE_PAGE_STEP)).toBe(3 + MESSAGE_PAGE_STEP);
  expect(resolveRowBudget('1', MESSAGE_PAGE_STEP * 2)).toBe(1 + MESSAGE_PAGE_STEP * 2);
  // `All` is absolute and unaffected by paging state.
  expect(resolveRowBudget('all', 0)).toBe(Number.POSITIVE_INFINITY);
  expect(resolveRowBudget('all', MESSAGE_PAGE_STEP)).toBe(Number.POSITIVE_INFINITY);
});
