/**
 * Ex AI Companion (handoff) panel — Part 3.
 *
 * Guards the handoff surface's legibility contracts:
 *  - the coordinator status maps to a stable, visible handoff-state badge
 *    (setup / ready / recovering / closed) — `exAIStatusBadge` is authoritative;
 *  - a `ready` companion presents its suggested replies with a one-click handoff
 *    that goes through the existing `onHandoff` path (coordinator semantics
 *    unchanged: the requestId is deterministic per boundary+option);
 *  - non-ready states never render clickable handoff options.
 */

import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExAIChatPanel, exAIStatusBadge } from './ExAIChatPanel';
import type { ExAIChatState } from '../useExAIChat';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const noop = async () => {};

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
});

test('maps every companion status to a distinct legible badge label', () => {
  expect(exAIStatusBadge('setup').label).toBe('Setup');
  expect(exAIStatusBadge('ready').label).toBe('Ready');
  expect(exAIStatusBadge('recovering').label).toBe('Recovering');
  expect(exAIStatusBadge('closed').label).toBe('Closed');
  expect(exAIStatusBadge('retired').label).toBe('Retired');
  // Ready is the only tone that signals the handoff is available.
  expect(exAIStatusBadge('ready').tone).toBe('ready');
});

test.skipIf(!hasDom)('shows the handoff-state header in every state', async () => {
  const state: ExAIChatState = { status: 'recovering', history: [], defaults: { model: 'm', instruction: '' } };
  const container = await render(
    <ExAIChatPanel state={state} error={null} onStart={noop} onSend={noop} onHandoff={noop} />,
  );
  const header = container.querySelector('[data-ex-ai-status="recovering"]');
  expect(header).not.toBeNull();
  expect(header!.textContent).toContain('Recovering');
});

test.skipIf(!hasDom)('a ready companion offers one-click handoff of a suggested reply', async () => {
  const calls: Array<{ requestId: string; text: string }> = [];
  const state: ExAIChatState = {
    status: 'ready',
    pair: { main: { paneId: 'w:p1', sessionId: 's1' }, companion: { paneId: 'w:c1', sessionId: 'sc1' }, model: 'gpt', instruction: '' },
    history: [],
    defaults: { model: 'gpt', instruction: '' },
    suggestion: { boundaryId: 'boundary-1', options: ['Approve and continue', 'Ask for tests'] },
  };
  const container = await render(
    <ExAIChatPanel
      state={state}
      error={null}
      onStart={noop}
      onSend={noop}
      onHandoff={async (requestId, text) => { calls.push({ requestId, text }); }}
    />,
  );

  const options = container.querySelector('[data-ex-ai-options="true"]');
  expect(options).not.toBeNull();
  const buttons = Array.from(options!.querySelectorAll('button'));
  expect(buttons.length).toBe(2);

  await act(async () => {
    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  // Handoff went through the existing path with the deterministic per-boundary id.
  expect(calls).toEqual([{ requestId: 'suggest:boundary-1:0', text: 'Approve and continue' }]);
});

test.skipIf(!hasDom)('never renders clickable suggestions outside the ready state', async () => {
  const state: ExAIChatState = {
    status: 'setup',
    history: [],
    defaults: { model: 'm', instruction: '' },
    // A stale suggestion must not leak a handoff affordance while not ready.
    suggestion: { boundaryId: 'boundary-1', options: ['stale option'] },
  };
  const container = await render(
    <ExAIChatPanel state={state} error={null} onStart={noop} onSend={noop} onHandoff={noop} />,
  );
  expect(container.querySelector('[data-ex-ai-options="true"]')).toBeNull();
});
