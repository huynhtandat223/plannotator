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
      activeTimelineMessages={[...messages.filter((item) => item.paneId === 'p1')].reverse()}
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

test.skipIf(!hasDom)('uses one unambiguous workspace · paneTab session identity and the newest preview', async () => {
  const el = await render();
  const sessions = el.querySelector('[role="listbox"]')!;
  expect(sessions.textContent).toContain('firstmate · compile');
  expect(sessions.textContent).toContain('firstmate · tests');
  expect(sessions.textContent).toContain('newest compiler response');
  expect(sessions.textContent).toContain('latest tests response');
  expect(sessions.textContent).not.toContain('older compiler response');
  expect(sessions.textContent).toContain('1');
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

test.skipIf(!hasDom)('waiting pane uses pane fallback and preserves its human identity', async () => {
  const waiting = [message('p3:waiting', 'p3', undefined, 'unregistered', 'Waiting for response', undefined)];
  const el = await render({
    messages: waiting,
    activeSessionKey: 'pane:p3',
    selectedMessageId: 'p3:waiting',
    unreadCountBySession: {},
    newReplyCount: 0,
  });
  expect(el.querySelector('[role="listbox"]')?.textContent).toContain('firstmate · unregistered');
  expect(el.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('true');
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

test.skipIf(!hasDom)('mobile opens a full-height accessible session selection sheet without removing the timeline', async () => {
  const el = await render();
  const opener = Array.from(el.querySelectorAll('button')).find((button) => button.textContent === 'Sessions')!;
  await act(async () => opener.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const dialog = el.querySelector('[role="dialog"][aria-label="Choose live session"]') as HTMLElement;
  expect(dialog).toBeTruthy();
  expect(dialog.className).toContain('h-[100dvh]');
  expect(dialog.textContent).toContain('firstmate · compile');
  expect(el.querySelector('[data-live-timeline-scroll="true"]')).toBeTruthy();
});

test.skipIf(!hasDom)('unambiguously maps session headers to workspace and tab', async () => {
  const el = await render();
  const header = el.querySelector('header')!;
  expect(header.textContent).toContain('firstmate');
  expect(header.textContent).toContain('compile');
});

test.skipIf(!hasDom)('aligns visibility with lg: breakpoints for desktop session picker and mobile controls', async () => {
  const el = await render();
  
  // Desktop inline SessionList should be hidden on mobile width (lg:block)
  const desktopList = el.querySelector('.border-b.lg\\:block');
  expect(desktopList).toBeTruthy();
  expect(desktopList?.className).toContain('hidden');
  expect(desktopList?.className).toContain('lg:block');

  // Mobile Sessions button opener should be hidden on desktop width (lg:hidden)
  const mobileOpener = Array.from(el.querySelectorAll('button')).find((button) => button.textContent === 'Sessions')!;
  expect(mobileOpener.className).toContain('lg:hidden');
});

test.skipIf(!hasDom)('at mobile 412x915, history is collapsed by default, displays only selected response primacy, and toggles history correctly', async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 412;
  window.dispatchEvent(new Event('resize'));

  try {
    const messages = [
      message('p1:r3', 'p1', 'pi-1', 'compile', 'newest turn response'),
      message('p1:r2', 'p1', 'pi-1', 'compile', 'selected middle response'),
      message('p1:r1', 'p1', 'pi-1', 'compile', 'older response'),
    ];
    // Render on mobile with selectedMessageId set to middle response
    const el = await render({
      messages,
      activeTimelineMessages: [...messages].reverse(),
      selectedMessageId: 'p1:r2',
    });

    // 1. Proving default collapsed state and selected response primacy
    // When collapsed, only the selected message should be rendered inside the timeline scroll area.
    const messageRows = Array.from(el.querySelectorAll('[data-live-timeline-scroll="true"] button')).filter((btn) => 
      btn.textContent?.includes('response') && !btn.textContent?.includes('Jump') && !btn.textContent?.includes('Back')
    );
    expect(messageRows.length).toBe(1);
    expect(messageRows[0].textContent).toContain('selected middle response');
    expect(messageRows[0].textContent).not.toContain('newest turn response');
    expect(messageRows[0].textContent).not.toContain('older response');

    // Header has "Show history" button by default on mobile
    const toggleBtn = Array.from(el.querySelectorAll('button')).find((btn) => btn.textContent === 'Show history')!;
    expect(toggleBtn).toBeTruthy();

    // 2. Toggle behavior - expand
    await act(async () => toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    
    // Now history is expanded. All 3 messages should be visible inside the timeline scroll area.
    const expandedMessageRows = Array.from(el.querySelectorAll('[data-live-timeline-scroll="true"] button')).filter((btn) => 
      btn.textContent?.includes('response') && !btn.textContent?.includes('Jump') && !btn.textContent?.includes('Back')
    );
    expect(expandedMessageRows.length).toBe(3);
    
    // Header should now show "Hide history" button
    const hideBtn = Array.from(el.querySelectorAll('button')).find((btn) => btn.textContent === 'Hide history')!;
    expect(hideBtn).toBeTruthy();

    // 3. Toggle behavior - collapse
    await act(async () => hideBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Back to collapsed. Only selected response visible inside the timeline scroll area.
    const collapsedMessageRows = Array.from(el.querySelectorAll('[data-live-timeline-scroll="true"] button')).filter((btn) => 
      btn.textContent?.includes('response') && !btn.textContent?.includes('Jump') && !btn.textContent?.includes('Back')
    );
    expect(collapsedMessageRows.length).toBe(1);
    expect(collapsedMessageRows[0].textContent).toContain('selected middle response');

  } finally {
    window.innerWidth = originalWidth;
    window.dispatchEvent(new Event('resize'));
  }
});

test.skipIf(!hasDom)('displays Back to latest button and navigates back when selected response is not the latest', async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 1024; // desktop to show all
  window.dispatchEvent(new Event('resize'));

  try {
    const messages = [
      message('p1:r3', 'p1', 'pi-1', 'compile', 'latest turn response'),
      message('p1:r2', 'p1', 'pi-1', 'compile', 'older response 2'),
      message('p1:r1', 'p1', 'pi-1', 'compile', 'older response 1'),
    ];
    
    const selectedIds: string[] = [];
    const el = await render({
      messages,
      activeTimelineMessages: [...messages].reverse(),
      selectedMessageId: 'p1:r2', // older response selected
      onSelectMessage: (id) => selectedIds.push(id),
    });

    const backToLatestBtn = Array.from(el.querySelectorAll('[data-live-timeline-scroll="true"] button')).find((btn) => btn.textContent === 'Back to latest')!;
    expect(backToLatestBtn).toBeTruthy();

    await act(async () => backToLatestBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(selectedIds).toEqual(['p1:r3']); // should select latest message ID

  } finally {
    window.innerWidth = originalWidth;
    window.dispatchEvent(new Event('resize'));
  }
});
