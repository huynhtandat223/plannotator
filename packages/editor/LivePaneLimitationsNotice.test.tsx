import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LivePaneLimitationsNotice } from './LivePaneLimitationsNotice';
import { livePaneAgentLabel, livePaneComposerCaveat, livePaneLimitations } from '@plannotator/core/live-pane-agents';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

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

function noticeFor(agent: string): React.ReactElement {
  return (
    <LivePaneLimitationsNotice
      agentLabel={livePaneAgentLabel(agent)}
      limitations={livePaneLimitations(agent)}
      composerDeliveryCaveat={livePaneComposerCaveat(agent)}
    />
  );
}

test.skipIf(!hasDom)('renders nothing for a Pi pane, so the Pi header is unchanged', async () => {
  const container = await render(noticeFor('pi'));
  expect(container.textContent).toBe('');
});

test.skipIf(!hasDom)('names the agent and every capability a Claude Code pane lacks', async () => {
  const container = await render(noticeFor('claude'));
  const text = container.textContent ?? '';
  expect(text).toContain('Claude Code panes are limited');
  for (const label of ['Activity trail', 'Context usage', 'Slash commands', 'Ex AI Chat']) {
    expect(text).toContain(label);
  }
  // A transcript IS available for Claude Code, so it must not be listed missing.
  expect(text).not.toContain('Chat transcript');
  // Sends DO work for Claude Code via Herdr composer delivery, so feedback is
  // not in the missing list — instead the collapsed line flags typed delivery.
  expect(text).not.toContain('Not available here: Send feedback');
  expect(text).toContain('Sends are typed into the composer via Herdr.');
});

test.skipIf(!hasDom)('reveals the concrete reason for each limitation on demand', async () => {
  const container = await render(noticeFor('claude'));
  const toggle = container.querySelector('button')!;
  expect(container.textContent).not.toContain('publishes no per-turn tool activity');

  await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  // The reason, not just the name — "unavailable" alone would leave the user
  // exactly as puzzled as an unexplained empty pane.
  expect(container.textContent).toContain('publishes no per-turn tool activity');
  // The composer delivery caveat is part of the expanded details, stating the
  // exact weaker guarantees the typed path honours.
  expect(container.textContent).toContain('cannot verify which session is active');
  expect(container.textContent).toContain('refuses to send while the agent is busy');

  await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('says a Codex pane has no transcript rather than implying one is loading', async () => {
  const container = await render(noticeFor('codex'));
  expect(container.textContent).toContain('Codex panes are limited');
  expect(container.textContent).toContain('Chat transcript');
});

test.skipIf(!hasDom)('lists an unrecognised agent kind honestly instead of promising anything', async () => {
  const container = await render(noticeFor('some-future-agent'));
  const text = container.textContent ?? '';
  expect(text).toContain('Some Future Agent panes are limited');
  expect(text).toContain('Chat transcript');
  expect(text).toContain('Send feedback');
});
