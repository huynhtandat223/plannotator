/**
 * Showing/hiding the WHOLE Agent Response panel from the app's existing rail.
 *
 * The rail is already the left-edge control strip (TOC / Files / Git Changes),
 * so the panel's visibility joins it rather than becoming a bespoke control
 * floating beside the panel — and the flag states which way pressing it goes.
 */

import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarTabs } from './SidebarTabs';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(props: Partial<React.ComponentProps<typeof SidebarTabs>> = {}): Promise<HTMLElement> {
  // Re-rendering within a test replaces the previous mount rather than leaking it.
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SidebarTabs
        activeTab="toc"
        onToggleTab={() => {}}
        hasDiff={false}
        {...props}
      />,
    );
  });
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const flag = (el: HTMLElement) => el.querySelector('[data-agent-response-tab="true"]') as HTMLButtonElement | null;

test.skipIf(!hasDom)('offers no panel flag outside a live session', async () => {
  expect(flag(await render())).toBeNull();
  // Opting in without a handler must not render a dead control either.
  expect(flag(await render({ showAgentResponseTab: true }))).toBeNull();
});

test.skipIf(!hasDom)('puts the panel toggle in the existing rail, in its last slot', async () => {
  const toggles: number[] = [];
  const el = await render({
    showAgentResponseTab: true,
    onToggleAgentResponse: () => toggles.push(1),
    showFilesTab: true,
  });
  const rail = el.querySelector('[data-sidebar-tabs="true"]') as HTMLElement;
  const control = flag(el)!;
  expect(control).toBeTruthy();
  // Same rail, same flag shape — one left-edge control strip, not two.
  expect(control.className).toContain('sidebar-tab-flag');
  // LAST, not first: the captain reads the flags above it as document
  // navigation (contents, files, changes) and asked for Agent Response to sit
  // beneath them as the rail's final slot.
  const children = Array.from(rail.children);
  expect(children.indexOf(control)).toBe(children.length - 1);
  expect(children.length).toBeGreaterThan(1);

  await act(async () => control.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(toggles).toEqual([1]);
});

test.skipIf(!hasDom)('states the panel state, and names the action rather than the noun', async () => {
  const shown = flag(await render({ showAgentResponseTab: true, onToggleAgentResponse: () => {} }))!;
  // Default is shown: pressed, and the label says what a press will DO next.
  expect(shown.getAttribute('aria-pressed')).toBe('true');
  expect(shown.getAttribute('aria-label')).toBe('Hide Agent Response panel');
  expect(shown.className).toContain('text-primary');

  const hidden = flag(await render({
    showAgentResponseTab: true,
    onToggleAgentResponse: () => {},
    isAgentResponseVisible: false,
  }))!;
  expect(hidden.getAttribute('aria-pressed')).toBe('false');
  expect(hidden.getAttribute('aria-label')).toBe('Show Agent Response panel');
});

test.skipIf(!hasDom)('is a real button, so Enter and Space work without extra key handling', async () => {
  const el = await render({ showAgentResponseTab: true, onToggleAgentResponse: () => {} });
  const control = flag(el)!;
  expect(control.tagName).toBe('BUTTON');
  expect(control.getAttribute('type')).toBe('button');
  // Nothing removes it from the tab order, so the rail is keyboard-reachable.
  expect(control.hasAttribute('disabled')).toBe(false);
  expect(control.getAttribute('tabindex')).toBeNull();
});

test.skipIf(!hasDom)('announces replies that arrived while the panel was away', async () => {
  const away = await render({
    showAgentResponseTab: true,
    onToggleAgentResponse: () => {},
    isAgentResponseVisible: false,
    agentResponseUnreadCount: 3,
  });
  expect(flag(away)!.querySelector('[aria-label="3 unread replies while hidden"]')).toBeTruthy();

  // With the panel on screen the unread lives on its own rows, so the rail
  // must not double-report it.
  const onScreen = await render({
    showAgentResponseTab: true,
    onToggleAgentResponse: () => {},
    isAgentResponseVisible: true,
    agentResponseUnreadCount: 3,
  });
  expect(flag(onScreen)!.querySelector('[aria-label*="unread"]')).toBeNull();

  const quiet = await render({
    showAgentResponseTab: true,
    onToggleAgentResponse: () => {},
    isAgentResponseVisible: false,
    agentResponseUnreadCount: 0,
  });
  expect(flag(quiet)!.querySelector('[aria-label*="unread"]')).toBeNull();
});

test.skipIf(!hasDom)('a rail reduced to one flag still carries the Agent Response toggle', async () => {
  // Wide/focus mode keeps its promise to put the panels away, so every other
  // flag is suppressed — but the rail is the toggle's only home above `lg`, so
  // suppressing it too is what strands the panel on screen with no control.
  const el = await render({
    showTocTab: false,
    showAgentResponseTab: true,
    isAgentResponseVisible: true,
    onToggleAgentResponse: () => {},
  });
  const buttons = Array.from(el.querySelectorAll('button'));
  expect(buttons).toHaveLength(1);
  expect(buttons[0]).toBe(flag(el)!);
  expect(flag(el)!.getAttribute('aria-label')).toBe('Hide Agent Response panel');
  expect(flag(el)!.getAttribute('aria-pressed')).toBe('true');
});

test.skipIf(!hasDom)('the TOC flag is on by default, so no other caller loses it', async () => {
  const el = await render({ showAgentResponseTab: true, onToggleAgentResponse: () => {} });
  const titles = Array.from(el.querySelectorAll('button')).map(b => b.getAttribute('title'));
  expect(titles).toContain('Table of Contents');
});
