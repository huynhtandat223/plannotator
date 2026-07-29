import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiveSessionTimeline } from './LiveSessionTimeline';
import type { PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const message = (
  messageId: string,
  paneId: string,
  piSessionId: string | undefined,
  paneTab: string,
  text: string,
  assistantMessageId = messageId,
): PickerMessage => ({
  messageId,
  paneId,
  ...(piSessionId ? { piSessionId } : {}),
  paneLabel: 'firstmate',
  paneTab,
  text,
  assistantMessageId,
  agentStatus: 'idle',
});

async function render(props: Partial<React.ComponentProps<typeof LiveSessionTimeline>> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const messages = props.messages ?? [
    message('p1:r2', 'p1', 'pi-1', 'compile', 'newest compiler response'),
    message('p1:r1', 'p1', 'pi-1', 'compile', 'older compiler response'),
    message('p2:r1', 'p2', 'pi-2', 'tests', 'latest tests response'),
  ];
  await act(async () => root!.render(
    <LiveSessionTimeline
      messages={messages}
      activeTimelineMessages={messages.filter((item) => item.paneId === 'p1')}
      activeSessionKey="pi:pi-1"
      selectedMessageId="p1:r1"
      unreadCountBySession={{ 'pi:pi-2': ['p2:r1'] }}
      newReplyCount={1}
      annotationCounts={new Map([['p1:r1', 2]])}
      captainEchoes={new Map()}
      onActivateSession={() => {}}
      onSelectMessage={() => {}}
      onJumpToNewReplies={() => {}}
      jumpToLatestSignal={0}
      {...props}
    />,
  ));
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** The pane list is a toggle now, so a test that inspects it opens it first. */
async function openSwitcher(el: HTMLElement): Promise<HTMLElement> {
  const switcher = el.querySelector('[data-live-session-switcher="true"]') as HTMLButtonElement;
  await act(async () => switcher.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  return switcher;
}

/** Run a body at a mobile viewport, restoring the real one afterwards. */
async function atMobileViewport(body: () => Promise<void>): Promise<void> {
  const width = window.innerWidth;
  const height = window.innerHeight;
  window.innerWidth = 412;
  window.innerHeight = 915;
  window.dispatchEvent(new Event('resize'));
  try {
    await body();
  } finally {
    window.innerWidth = width;
    window.innerHeight = height;
    window.dispatchEvent(new Event('resize'));
  }
}

test.skipIf(!hasDom)('uses one unambiguous workspace · paneTab session identity and the newest preview', async () => {
  const el = await render();
  await openSwitcher(el);
  const sessions = el.querySelector('[role="listbox"]')!;
  expect(sessions.textContent).toContain('firstmate · compile');
  expect(sessions.textContent).toContain('firstmate · tests');
  expect(sessions.textContent).toContain('newest compiler response');
  expect(sessions.textContent).toContain('latest tests response');
  expect(sessions.textContent).not.toContain('older compiler response');
  expect(sessions.textContent).toContain('1');
});

test.skipIf(!hasDom)('gives the response history the whole panel until the captain opens the pane list', async () => {
  const el = await render();
  // Closed by default: no pane band competing with the transcript.
  expect(el.querySelector('[role="listbox"]')).toBeNull();
  const switcher = el.querySelector('[data-live-session-switcher="true"]')!;
  expect(switcher.getAttribute('aria-expanded')).toBe('false');
  // The header itself names the pane you are reading, and is the switcher.
  expect(switcher.textContent).toContain('firstmate · compile');

  await openSwitcher(el);
  expect(el.querySelector('[role="listbox"]')).toBeTruthy();
  expect(el.querySelector('[data-live-session-switcher="true"]')!.getAttribute('aria-expanded')).toBe('true');

  await openSwitcher(el);
  expect(el.querySelector('[role="listbox"]')).toBeNull();
});

test.skipIf(!hasDom)('closes the pane list once a pane is chosen, and on Escape', async () => {
  const activated: string[] = [];
  const el = await render({ onActivateSession: (key) => activated.push(key) });

  await openSwitcher(el);
  const tests = Array.from(el.querySelectorAll('[role="option"]')).find((option) => option.textContent?.includes('firstmate · tests'))!;
  await act(async () => tests.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(activated).toEqual(['pi:pi-2']);
  // One click to open, one to pick, straight back to the full-height history.
  expect(el.querySelector('[role="listbox"]')).toBeNull();

  await openSwitcher(el);
  expect(el.querySelector('[role="listbox"]')).toBeTruthy();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(el.querySelector('[role="listbox"]')).toBeNull();
});

test.skipIf(!hasDom)('surfaces unread waiting in other panes on the switcher itself', async () => {
  const el = await render({ unreadCountBySession: { 'pi:pi-2': ['p2:r1', 'p2:r0'] } });
  const switcher = el.querySelector('[data-live-session-switcher="true"]')!;
  // Closed, the badge is the only reason to open the list — so it lives on it.
  expect(switcher.querySelector('[aria-label="2 unread replies in other panes"]')).toBeTruthy();

  // Unread in the pane you are already reading is not a reason to switch.
  await act(async () => root!.render(
    <LiveSessionTimeline
      messages={[
        message('p1:r2', 'p1', 'pi-1', 'compile', 'newest compiler response'),
        message('p2:r1', 'p2', 'pi-2', 'tests', 'latest tests response'),
      ]}
      activeTimelineMessages={[message('p1:r2', 'p1', 'pi-1', 'compile', 'newest compiler response')]}
      activeSessionKey="pi:pi-1"
      selectedMessageId="p1:r2"
      unreadCountBySession={{ 'pi:pi-1': ['p1:r2'] }}
      newReplyCount={0}
      annotationCounts={new Map()}
      captainEchoes={new Map()}
      onActivateSession={() => {}}
      onSelectMessage={() => {}}
      onJumpToNewReplies={() => {}}
      jumpToLatestSignal={0}
    />,
  ));
  expect(el.querySelector('[data-live-session-switcher="true"]')!.querySelector('[aria-label*="other panes"]')).toBeNull();
});

test.skipIf(!hasDom)('keeps response selection as an explicit annotation-target action', async () => {
  const selected: string[] = [];
  const el = await render({ onSelectMessage: (id) => selected.push(id) });
  const response = Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.includes('older compiler response'))!;
  await act(async () => response.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(selected).toEqual(['p1:r1']);
});

test.skipIf(!hasDom)('switches sessions only after an explicit captain click', async () => {
  const activated: string[] = [];
  const el = await render({ onActivateSession: (key) => activated.push(key) });
  await openSwitcher(el);
  // Opening the picker is navigation-free on its own.
  expect(activated).toEqual([]);
  const tests = Array.from(el.querySelectorAll('button')).find((button) => button.getAttribute('role') === 'option' && button.textContent?.includes('firstmate · tests'))!;
  await act(async () => tests.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(activated).toEqual(['pi:pi-2']);
});

test.skipIf(!hasDom)('renders a non-navigating active-session New replies jump control', async () => {
  const jumps: number[] = [];
  const el = await render({ onJumpToNewReplies: () => jumps.push(1), newReplyCount: 2 });
  const jump = Array.from(el.querySelectorAll('button')).find((button) => button.textContent?.includes('2 new replies'))!;
  expect(jump).toBeTruthy();
  await act(async () => jump.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(jumps).toEqual([1]);
});

test.skipIf(!hasDom)('waiting pane uses pane fallback and offers no switcher when it is the only pane', async () => {
  const waiting = [message('p3:waiting', 'p3', undefined, 'unregistered', 'Waiting for response', undefined)];
  const el = await render({
    messages: waiting,
    activeSessionKey: 'pane:p3',
    selectedMessageId: 'p3:waiting',
    unreadCountBySession: {},
    newReplyCount: 0,
  });
  expect(el.querySelector('header')?.textContent).toContain('firstmate · unregistered');
  // One pane has nothing to switch to: no dead control, no list.
  expect(el.querySelector('[data-live-session-switcher="true"]')).toBeNull();
  expect(el.querySelector('[role="listbox"]')).toBeNull();
});

test.skipIf(!hasDom)('preserves independent session selection when a parent applies a background frame', async () => {
  const received: string[] = [];
  const props = {
    messages: [
      message('p1:r1', 'p1', 'pi-1', 'compile', 'compile response'),
      message('p2:r1', 'p2', 'pi-2', 'tests', 'tests response'),
    ],
    activeTimelineMessages: [message('p1:r1', 'p1', 'pi-1', 'compile', 'compile response')],
    activeSessionKey: 'pi:pi-1' as const,
    selectedMessageId: 'p1:r1',
    unreadCountBySession: { 'pi:pi-2': ['p2:r1'] },
    newReplyCount: 0,
    annotationCounts: new Map(),
    captainEchoes: new Map(),
    onActivateSession: (key: string) => received.push(`session:${key}`),
    onSelectMessage: (id: string) => received.push(`message:${id}`),
    onJumpToNewReplies: () => {},
    jumpToLatestSignal: 0,
  };
  const el = await render(props);
  await act(async () => root!.render(<LiveSessionTimeline {...props} messages={[
    message('p1:r1', 'p1', 'pi-1', 'compile', 'compile response'),
    message('p2:r2', 'p2', 'pi-2', 'tests', 'new background tests response'),
    message('p2:r1', 'p2', 'pi-2', 'tests', 'tests response'),
  ]} activeTimelineMessages={[message('p1:r1', 'p1', 'pi-1', 'compile', 'compile response')]} unreadCountBySession={{ 'pi:pi-2': ['p2:r2', 'p2:r1'] }} />));
  expect(received).toEqual([]);
  expect(el.querySelector('[aria-current="true"]')?.textContent).toContain('compile response');
  expect(el.textContent).toContain('2');
});

test.skipIf(!hasDom)('the same switcher opens a bounded sheet on mobile, which takes focus and closes on Escape', async () => {
  await atMobileViewport(async () => {
    const el = await render();
    // One control, one mental model: the header names the pane and switches it.
    const switcher = el.querySelector('[data-live-session-switcher="true"]')!;
    expect(switcher.getAttribute('aria-haspopup')).toBe('dialog');
    await act(async () => switcher.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const dialog = el.querySelector('[role="dialog"][aria-label="Choose live session"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    // Content-bounded bottom sheet, not a mostly-empty full-screen takeover.
    expect(dialog.className).toContain('max-h-[85dvh]');
    expect(dialog.className).not.toContain('h-[100dvh]');
    expect(dialog.textContent).toContain('firstmate · compile');

    // Focus must move into the modal, not stay stranded behind the overlay.
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(el.querySelector('[role="dialog"][aria-label="Choose live session"]')).toBeNull();
  });
});

test.skipIf(!hasDom)('gives the session listbox one tab stop, arrow-key navigation, and the keyboard on open', async () => {
  const el = await render();
  await openSwitcher(el);
  const listbox = el.querySelector('[role="listbox"]') as HTMLElement;
  const options = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(options.length).toBe(2);

  // Roving tabindex: only the active session is in the tab order.
  expect(options.filter((option) => option.tabIndex === 0).length).toBe(1);
  expect(options.find((option) => option.tabIndex === 0)!.getAttribute('aria-selected')).toBe('true');
  // Opening the picker puts the keyboard on the pane you are already reading.
  expect(document.activeElement).toBe(options[0]);

  await act(async () => listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(document.activeElement).toBe(options[1]);
  await act(async () => listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(document.activeElement).toBe(options[0]);
  await act(async () => listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(document.activeElement).toBe(options[1]);
});

test.skipIf(!hasDom)('scrolls the active session into view instead of leaving it below the fold', async () => {
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function scrollIntoViewSpy(this: Element) {
    scrolled.push(this.getAttribute('aria-selected') ?? 'none');
  };
  try {
    const el = await render();
    await openSwitcher(el);
    // Opening the picker reveals the pane you are on, wherever it sits.
    expect(scrolled).toContain('true');
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test.skipIf(!hasDom)('keeps one caption for the transcript rather than stacking list and workspace headings', async () => {
  const el = await render();
  const transcript = el.querySelector('[data-live-timeline-scroll="true"]')!;
  // The panel header already names the session; the browser must not repeat it.
  expect(transcript.textContent).not.toContain('Recent responses');
  expect(transcript.textContent).not.toContain('FIRSTMATE');
  expect(transcript.textContent).toContain('newest compiler response');
});

test.skipIf(!hasDom)('leads the transcript with the newest response, in DOM and tab order', async () => {
  const messages = Array.from({ length: 4 }, (_, index) =>
    message(`p1:r${4 - index}`, 'p1', 'pi-1', 'compile', `response ${4 - index}`),
  );
  const el = await render({
    messages,
    activeTimelineMessages: messages,
    selectedMessageId: 'p1:r4',
    unreadCountBySession: {},
    newReplyCount: 0,
  });
  const transcript = el.querySelector('[data-live-timeline-scroll="true"]') as HTMLElement;
  const rows = Array.from(transcript.querySelectorAll('button')).filter(
    (button) => button.textContent?.startsWith('response'),
  );
  // Real DOM order, not a CSS reversal: reading order and tab order agree, so
  // the response the captain came for is both the first thing on screen and
  // the first thing the keyboard reaches.
  expect(rows.map((row) => row.textContent!.slice(0, 10))).toEqual([
    'response 4', 'response 3', 'response 2', 'response 1',
  ]);
  // The ★ default annotation target rides with the newest row, at the top.
  expect(rows[0]!.textContent).toContain('★ Latest');
  // The region announces its ordering rather than leaving it to be inferred.
  expect(transcript.getAttribute('aria-label')).toBe('Response history — newest first');
});

test.skipIf(!hasDom)('strips markdown syntax out of the session switcher previews', async () => {
  const noisy = message('p1:r1', 'p1', 'pi-1', 'compile', '# Heading\n\n> [!WARNING]\n> **Bold warning** body');
  const el = await render({
    messages: [noisy, message('p2:r1', 'p2', 'pi-2', 'tests', 'plain tests response')],
    activeTimelineMessages: [noisy],
    activeSessionKey: 'pi:pi-1',
    selectedMessageId: 'p1:r1',
    unreadCountBySession: {},
    newReplyCount: 0,
  });
  await openSwitcher(el);
  const listbox = el.querySelector('[role="listbox"]')!;
  expect(listbox.textContent).toContain('Heading Bold warning body');
  expect(listbox.textContent).not.toContain('[!WARNING]');
  expect(listbox.textContent).not.toContain('**');
});

test.skipIf(!hasDom)('unambiguously maps session headers to workspace and tab', async () => {
  const el = await render();
  const header = el.querySelector('header')!;
  expect(header.textContent).toContain('firstmate');
  expect(header.textContent).toContain('compile');
});

test.skipIf(!hasDom)('routes the one switcher to the inline picker on desktop and the sheet on mobile', async () => {
  const el = await render();
  const desktopSwitcher = el.querySelector('[data-live-session-switcher="true"]')!;
  expect(desktopSwitcher.getAttribute('aria-haspopup')).toBe('listbox');
  await openSwitcher(el);
  // Desktop picker is inline (no modal) and still guarded by the lg: breakpoint.
  expect(el.querySelector('[role="dialog"]')).toBeNull();
  const desktopList = el.querySelector('.border-b.lg\\:block')!;
  expect(desktopList.className).toContain('hidden');
  expect(desktopList.className).toContain('lg:block');

  // The mobile History control stays breakpoint-guarded.
  await act(async () => root!.unmount());
  host!.remove();
  await atMobileViewport(async () => {
    const mobile = await render();
    expect(mobile.querySelector('[data-live-session-switcher="true"]')!.getAttribute('aria-haspopup')).toBe('dialog');
    const history = Array.from(mobile.querySelectorAll('button')).find((button) => button.textContent === 'History')!;
    expect(history.className).toContain('lg:hidden');
  });
});

test.skipIf(!hasDom)('at mobile 412x915, history is collapsed by default, keeps the selected response primary, and toggles a bounded history', async () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  window.innerWidth = 412;
  window.innerHeight = 915;
  window.dispatchEvent(new Event('resize'));

  try {
    const messages = Array.from({ length: 6 }, (_, index) =>
      message(`p1:r${6 - index}`, 'p1', 'pi-1', 'compile', `response ${6 - index}`),
    );
    const selectedIds: string[] = [];
    const el = await render({
      messages,
      activeTimelineMessages: messages,
      selectedMessageId: 'p1:r3',
      onSelectMessage: (id) => selectedIds.push(id),
    });

    const selectedResponse = el.querySelector('[data-live-timeline-selected-response="true"]')!;
    expect(selectedResponse.textContent).toContain('response 3');
    expect(selectedResponse.textContent).not.toContain('response 6');
    expect(el.querySelector('[data-live-timeline-scroll="true"]')).toBeNull();

    const showHistory = Array.from(el.querySelectorAll('button')).find((button) => button.textContent === 'History')!;
    expect(showHistory).toBeTruthy();

    await act(async () => showHistory.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const history = el.querySelector('[data-live-timeline-scroll="true"]') as HTMLElement;
    expect(history.getAttribute('aria-label')).toBe('Response history — newest first');
    expect(history.style.overflowY).toBe('auto');
    const historyRows = Array.from(history.querySelectorAll('button')).filter((button) => button.textContent?.startsWith('response'));
    expect(historyRows).toHaveLength(6);
    expect(history.textContent).toContain('response 6');
    expect(history.textContent).toContain('response 1');

    const hideHistory = Array.from(el.querySelectorAll('button')).find((button) => button.textContent === 'Close')!;
    expect(hideHistory).toBeTruthy();
    await act(async () => hideHistory.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelector('[data-live-timeline-scroll="true"]')).toBeNull();
    expect(el.querySelector('[data-live-timeline-selected-response="true"]')?.textContent).toContain('response 3');

    await act(async () => showHistory.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const backToLatest = Array.from(el.querySelectorAll('[data-live-timeline-scroll="true"] button')).find((button) => button.textContent === 'Back to latest')!;
    expect(backToLatest).toBeTruthy();
    await act(async () => backToLatest.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(selectedIds).toEqual(['p1:r6']);
  } finally {
    window.innerWidth = originalWidth;
    window.innerHeight = originalHeight;
    window.dispatchEvent(new Event('resize'));
  }
});
