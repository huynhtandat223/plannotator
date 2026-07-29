/**
 * Toggling the whole Agent Response panel off and back on.
 *
 * The panel is the app's composition of `agentResponsePanelWrapperClass` around
 * `LiveSessionTimeline`, so this mounts exactly that pairing and asserts the two
 * halves of the contract:
 *
 *  - OFF: the whole block — header, session row, history, chrome — is out of
 *    the flow, out of the tab order and out of the accessibility tree.
 *  - BACK ON: nothing the captain had going is disturbed. Active session,
 *    selected response, transcript scroll offset and paged-in rows survive,
 *    because the panel was hidden rather than unmounted.
 */

import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiveSessionTimeline } from './LiveSessionTimeline';
import { agentResponsePanelWrapperClass } from './live/agentResponsePanelLayout';
import type { PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const message = (messageId: string, text: string): PickerMessage => ({
  messageId,
  paneId: 'p1',
  piSessionId: 'pi-1',
  paneLabel: 'firstmate',
  paneTab: 'compile',
  text,
  assistantMessageId: messageId,
  agentStatus: 'idle',
});

const BASE_MESSAGES = [
  message('p1:r3', 'newest response'),
  message('p1:r2', 'middle response'),
  message('p1:r1', 'oldest response'),
];

type Interaction = { selected: string[]; activated: string[] };

/**
 * The App's composition, reduced to the two things under test: the visibility
 * wrapper, and a sibling standing in for the document that must reclaim the
 * space. `key` is deliberately absent from the wrapper so React reconciles the
 * same DOM node across a toggle, which is what preserves reader state.
 */
function Harness({
  visible,
  messages,
  interaction,
}: {
  visible: boolean;
  messages: PickerMessage[];
  interaction: Interaction;
}) {
  return (
    <div className="w-full relative flex flex-col lg:flex-row">
      <div
        data-agent-response-panel="true"
        data-agent-response-hidden={visible ? undefined : 'true'}
        className={agentResponsePanelWrapperClass(visible)}
        aria-hidden={!visible}
        inert={!visible ? true : undefined}
      >
        <LiveSessionTimeline
          messages={messages}
          activeTimelineMessages={messages}
          activeSessionKey="pi:pi-1"
          selectedMessageId="p1:r2"
          unreadCountBySession={{}}
          newReplyCount={0}
          annotationCounts={new Map()}
          captainEchoes={new Map()}
          onActivateSession={(key) => interaction.activated.push(key)}
          onSelectMessage={(id) => interaction.selected.push(id)}
          onJumpToNewReplies={() => {}}
          jumpToLatestSignal={0}
        />
      </div>
      <div data-document="true">document</div>
    </div>
  );
}

async function mount(interaction: Interaction) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  let messages = BASE_MESSAGES;
  let visible = true;
  const draw = async () => {
    await act(async () => root!.render(
      <Harness visible={visible} messages={messages} interaction={interaction} />,
    ));
  };
  await draw();
  return {
    host: host!,
    setVisible: async (next: boolean) => { visible = next; await draw(); },
    setMessages: async (next: PickerMessage[]) => { messages = next; await draw(); },
  };
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const wrapper = (el: HTMLElement) => el.querySelector('[data-agent-response-panel="true"]') as HTMLElement;
const scroller = (el: HTMLElement) => el.querySelector('[data-live-timeline-scroll="true"]') as HTMLElement;
const rowIds = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-message-row]')).map((row) => (row as HTMLElement).dataset.messageRow);

test.skipIf(!hasDom)('hides the whole block — header, session row and history — not just its contents', async () => {
  const interaction: Interaction = { selected: [], activated: [] };
  const ui = await mount(interaction);

  const panel = wrapper(ui.host);
  // Shown: the AGENT RESPONSE caption and its switcher are the block's chrome,
  // and they are exactly what has to leave with it.
  expect(panel.textContent).toContain('Agent Response');
  expect(panel.className).not.toContain('absolute');
  expect(panel.getAttribute('aria-hidden')).toBe('false');

  await ui.setVisible(false);

  const hidden = wrapper(ui.host);
  expect(hidden.className).toContain('absolute');
  expect(hidden.className).toContain('invisible');
  // Out of the accessibility tree and out of the tab order, so a keyboard or
  // screen-reader captain cannot land inside a panel they cannot see.
  expect(hidden.getAttribute('aria-hidden')).toBe('true');
  expect(hidden.hasAttribute('inert')).toBe(true);
  // The document sibling is still an ordinary in-flow block, now with the
  // whole area to itself.
  expect(ui.host.querySelector('[data-document="true"]')).toBeTruthy();
});

test.skipIf(!hasDom)('keeps the panel mounted while hidden, so nothing is rebuilt on the way back', async () => {
  const interaction: Interaction = { selected: [], activated: [] };
  const ui = await mount(interaction);
  const before = scroller(ui.host);
  expect(before).toBeTruthy();

  await ui.setVisible(false);
  // Still mounted: same node, same rows. Unmounting here is what would silently
  // discard scroll, paging and anchor state.
  expect(scroller(ui.host)).toBe(before);
  expect(rowIds(ui.host)).toEqual(['p1:r3', 'p1:r2', 'p1:r1']);

  await ui.setVisible(true);
  expect(scroller(ui.host)).toBe(before);
});

test.skipIf(!hasDom)('restores the reader exactly: scroll offset, selection and active session', async () => {
  const interaction: Interaction = { selected: [], activated: [] };
  const ui = await mount(interaction);

  const region = scroller(ui.host);
  await act(async () => { region.scrollTop = 140; });
  const selectedBefore = ui.host.querySelector('[aria-pressed="true"][data-message-row]') as HTMLElement;
  expect(selectedBefore.dataset.messageRow).toBe('p1:r2');

  await ui.setVisible(false);
  await ui.setVisible(true);

  expect(scroller(ui.host).scrollTop).toBe(140);
  const selectedAfter = ui.host.querySelector('[aria-pressed="true"][data-message-row]') as HTMLElement;
  expect(selectedAfter.dataset.messageRow).toBe('p1:r2');
  // The panel never reassigns ownership: only an explicit captain click may
  // move the active session or the annotation target.
  expect(interaction.selected).toEqual([]);
  expect(interaction.activated).toEqual([]);
});

test.skipIf(!hasDom)('keeps taking live frames while hidden, and never moves the selection', async () => {
  const interaction: Interaction = { selected: [], activated: [] };
  const ui = await mount(interaction);

  await ui.setVisible(false);
  // A live frame lands while the captain has the panel away.
  await ui.setMessages([message('p1:r4', 'live arrival'), ...BASE_MESSAGES]);
  // Newest-first ordering survives the hidden pass, unchanged from PR #48.
  expect(rowIds(ui.host)).toEqual(['p1:r4', 'p1:r3', 'p1:r2', 'p1:r1']);

  await ui.setVisible(true);
  expect(rowIds(ui.host)).toEqual(['p1:r4', 'p1:r3', 'p1:r2', 'p1:r1']);
  const selected = ui.host.querySelector('[aria-pressed="true"][data-message-row]') as HTMLElement;
  expect(selected.dataset.messageRow).toBe('p1:r2');
  expect(interaction.selected).toEqual([]);
  expect(interaction.activated).toEqual([]);
});
