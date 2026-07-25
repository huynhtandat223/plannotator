import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LivePaneChipsRow } from './LivePaneChipsRow';
import type { PaneChipSource } from './livePaneChips';

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

const pane = (over: Partial<PaneChipSource> & { messageId: string; paneId: string }): PaneChipSource => ({
  paneLabel: 'ws',
  paneTab: 't',
  agentStatus: 'idle',
  ...over,
});

test.skipIf(!hasDom)('renders one chip per pane with workspace · tab identity', async () => {
  const sources: PaneChipSource[] = [
    pane({ messageId: 'm1', paneId: 'p1', paneLabel: 'firstmate', paneTab: 't3H' }),
    pane({ messageId: 'm2', paneId: 'p2', paneLabel: 'firstmate', paneTab: 't9K' }),
  ];
  const el = await render(
    <LivePaneChipsRow sources={sources} selectedMessageId="m1" onSelect={() => {}} />,
  );
  const group = el.querySelector('[aria-label="Live Pi panes — click to switch pane"]')!;
  expect(group).toBeTruthy();
  const text = group.textContent ?? '';
  expect(text).toContain('firstmate · t3H');
  expect(text).toContain('firstmate · t9K');
});

test.skipIf(!hasDom)('renders nothing for a single pane', async () => {
  const el = await render(
    <LivePaneChipsRow
      sources={[pane({ messageId: 'm1', paneId: 'p1' })]}
      selectedMessageId="m1"
      onSelect={() => {}}
    />,
  );
  expect(el.querySelector('[aria-label="Live Pi panes — click to switch pane"]')).toBeNull();
});

test.skipIf(!hasDom)('clicking a chip selects that pane', async () => {
  const selected: string[] = [];
  const sources: PaneChipSource[] = [
    pane({ messageId: 'm1', paneId: 'p1', paneTab: 'a' }),
    pane({ messageId: 'm2', paneId: 'p2', paneTab: 'b' }),
  ];
  const el = await render(
    <LivePaneChipsRow sources={sources} selectedMessageId="m1" onSelect={(id) => selected.push(id)} />,
  );
  const buttons = Array.from(el.querySelectorAll('button')).filter((b) =>
    (b.getAttribute('title') ?? '').includes('· b'),
  );
  expect(buttons.length).toBeGreaterThan(0);
  await act(async () => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(selected).toEqual(['m2']);
});

test.skipIf(!hasDom)('selected pane chip is marked aria-current', async () => {
  const sources: PaneChipSource[] = [
    pane({ messageId: 'm1', paneId: 'p1', paneTab: 'a' }),
    pane({ messageId: 'm2', paneId: 'p2', paneTab: 'b' }),
  ];
  const el = await render(
    <LivePaneChipsRow sources={sources} selectedMessageId="m2" onSelect={() => {}} />,
  );
  const current = el.querySelector('button[aria-current="true"]')!;
  expect(current).toBeTruthy();
  expect(current.getAttribute('title')).toContain('· b');
});

test.skipIf(!hasDom)('overflow collapses into +N more and expands on click', async () => {
  // 8 idle panes; default maxVisible is 6 → 2 overflow.
  const sources: PaneChipSource[] = Array.from({ length: 8 }, (_v, i) =>
    pane({ messageId: `m${i}`, paneId: `p${i}`, paneTab: `t${i}` }),
  );
  const el = await render(
    <LivePaneChipsRow sources={sources} selectedMessageId="m0" onSelect={() => {}} />,
  );
  const more = Array.from(el.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('more'),
  )!;
  expect(more).toBeTruthy();
  expect(more.textContent).toContain('+2 more');
  await act(async () => more.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect((el.textContent ?? '')).toContain('Show less');
});

test.skipIf(!hasDom)('CTX warning tone applies at the threshold', async () => {
  const sources: PaneChipSource[] = [
    pane({
      messageId: 'm1',
      paneId: 'p1',
      paneTab: 'hot',
      contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
    }),
    pane({
      messageId: 'm2',
      paneId: 'p2',
      paneTab: 'cool',
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
    }),
  ];
  const el = await render(
    <LivePaneChipsRow sources={sources} selectedMessageId="m2" onSelect={() => {}} />,
  );
  const warn = el.querySelector('[title="Context 90% — near full"]');
  expect(warn).toBeTruthy();
  expect(el.querySelector('[title="Context 10%"]')).toBeTruthy();
});

test.skipIf(!hasDom)('recent-commands affordance reveals redacted commands on demand', async () => {
  const sources: PaneChipSource[] = [
    pane({
      messageId: 'm1',
      paneId: 'p1',
      paneTab: 'a',
      activityTrail: [{ kind: 'tool', name: 'bash', count: 1, command: 'npm test' }],
    }),
    pane({ messageId: 'm2', paneId: 'p2', paneTab: 'b' }),
  ];
  const el = await render(
    <LivePaneChipsRow sources={sources} selectedMessageId="m2" onSelect={() => {}} />,
  );
  // Command popover is not shown until the affordance is toggled.
  expect(el.querySelector('[aria-label="Latest commands for firstmate · a"]')).toBeNull();
  const toggle = el.querySelector<HTMLButtonElement>('button[aria-label="Recent commands for ws · a"]')!;
  expect(toggle).toBeTruthy();
  await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const popover = el.querySelector('[aria-label="Latest commands for ws · a"]')!;
  expect(popover).toBeTruthy();
  expect(popover.textContent).toContain('npm test');
});

test.skipIf(!hasDom)('recent-commands shows only the latest inline, older behind a toggle', async () => {
  const sources: PaneChipSource[] = [
    pane({
      messageId: 'm1',
      paneId: 'p1',
      paneTab: 'a',
      activityTrail: [
        { kind: 'tool', name: 'bash', count: 1, command: 'git status' },
        { kind: 'tool', name: 'bash', count: 1, command: 'npm ci' },
        { kind: 'tool', name: 'bash', count: 1, command: 'npm test' },
      ],
    }),
    pane({ messageId: 'm2', paneId: 'p2', paneTab: 'b' }),
  ];
  const el = await render(
    <LivePaneChipsRow sources={sources} selectedMessageId="m2" onSelect={() => {}} />,
  );
  const toggle = el.querySelector<HTMLButtonElement>('button[aria-label="Recent commands for ws · a"]')!;
  await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const popover = el.querySelector('[aria-label="Latest commands for ws · a"]')!;
  // Latest command is shown; older ones are hidden behind the toggle.
  expect(popover.textContent).toContain('npm test');
  expect(popover.textContent).not.toContain('git status');
  expect(popover.textContent).not.toContain('npm ci');
  const showOlder = Array.from(popover.querySelectorAll('button')).find((b) => /older/.test(b.textContent ?? ''))!;
  expect(showOlder).toBeTruthy();
  await act(async () => showOlder.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(popover.textContent).toContain('git status');
  expect(popover.textContent).toContain('npm ci');
});
