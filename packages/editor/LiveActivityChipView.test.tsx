import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiveActivityChip } from './LiveActivityChipView';
import { deriveLiveActivityChip } from './liveActivityChip';

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

test.skipIf(!hasDom)('working state renders exactly ONE indicator — the animated dot, no static glyph', async () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working' })!;
  const el = await render(<LiveActivityChip chip={chip} />);
  // The animated dot is present…
  const dots = el.querySelectorAll('[data-testid="live-working-dot"]');
  expect(dots).toHaveLength(1);
  // …and there is no second static ● glyph competing with it.
  expect(el.textContent).not.toContain('●');
  // The label still carries the meaning (a11y), not the animation alone.
  expect(el.textContent).toContain('Thinking…');
});

test.skipIf(!hasDom)('the working indicator + label is a SINGLE status element (no Thinking…+Working dup)', async () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working' })!;
  const el = await render(<LiveActivityChip chip={chip} />);
  const statuses = el.querySelectorAll('[role="status"]');
  expect(statuses).toHaveLength(1);
  // The one element says the working state once — not "Thinking…" and "Working".
  expect(el.textContent).not.toContain('Working');
});

test.skipIf(!hasDom)('reduced-motion fallback: the dot still renders (CSS disables the animation, meaning stays in the label)', async () => {
  // The animation is disabled purely in CSS via @media (prefers-reduced-motion);
  // the element itself is unconditional so the indicator never disappears and the
  // label always carries meaning. Assert the indicator + label are present.
  const chip = deriveLiveActivityChip({ agentStatus: 'working', activity: { kind: 'tool', name: 'bash', count: 1 } })!;
  const el = await render(<LiveActivityChip chip={chip} />);
  expect(el.querySelector('[data-testid="live-working-dot"]')).toBeTruthy();
  expect(el.textContent).toContain('Running bash');
});

test.skipIf(!hasDom)('calm states use a static glyph, never the animated dot', async () => {
  const idle = deriveLiveActivityChip({ agentStatus: 'idle' })!;
  const el = await render(<LiveActivityChip chip={idle} />);
  expect(el.querySelector('[data-testid="live-working-dot"]')).toBeNull();
  expect(el.textContent).toContain('○');
  expect(el.textContent).toContain('Idle');
});

test.skipIf(!hasDom)('blocked state stays calm (static ▲, no animation)', async () => {
  const blocked = deriveLiveActivityChip({ agentStatus: 'blocked' })!;
  const el = await render(<LiveActivityChip chip={blocked} />);
  expect(el.querySelector('[data-testid="live-working-dot"]')).toBeNull();
  expect(el.textContent).toContain('▲');
  expect(el.textContent).toContain('Blocked');
});

test.skipIf(!hasDom)('the single indicator is tied to its pane via the accessible label + title', async () => {
  const chip = deriveLiveActivityChip({ agentStatus: 'working' })!;
  const el = await render(<LiveActivityChip chip={chip} paneName="firstmate · t3H" />);
  const status = el.querySelector('[role="status"]')!;
  expect(status.getAttribute('aria-label')).toContain('firstmate · t3H');
  expect(status.getAttribute('title')).toContain('firstmate · t3H');
});
