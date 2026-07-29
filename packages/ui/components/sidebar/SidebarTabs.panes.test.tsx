/**
 * The live-pane toggle reuses the app's existing left rail.
 *
 * The rail is already the left-edge control strip (TOC / Files / Git Changes),
 * so the pane switcher joins it rather than the Agent Response panel growing a
 * second, bespoke left control beside it.
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

test.skipIf(!hasDom)('offers no pane flag when the host has nothing to switch between', async () => {
  const el = await render();
  expect(el.querySelector('[data-live-panes-tab="true"]')).toBeNull();
  // Opting in without a handler must not render a dead control either.
  const withoutHandler = await render({ showPanesTab: true });
  expect(withoutHandler.querySelector('[data-live-panes-tab="true"]')).toBeNull();
});

test.skipIf(!hasDom)('puts the pane toggle in the existing rail, ahead of the other flags', async () => {
  const toggles: number[] = [];
  const el = await render({
    showPanesTab: true,
    onTogglePanes: () => toggles.push(1),
    showFilesTab: true,
  });
  const rail = el.querySelector('[data-sidebar-tabs="true"]') as HTMLElement;
  const panes = rail.querySelector('[data-live-panes-tab="true"]') as HTMLButtonElement;
  expect(panes).toBeTruthy();
  // Same rail, same flag shape — one left-edge control strip, not two.
  expect(panes.className).toContain('sidebar-tab-flag');
  expect(Array.from(rail.children).indexOf(panes)).toBe(0);
  expect(panes.getAttribute('aria-expanded')).toBe('false');

  await act(async () => panes.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(toggles).toEqual([1]);
});

test.skipIf(!hasDom)('reflects the open pane list and unread waiting in other panes', async () => {
  const el = await render({ showPanesTab: true, onTogglePanes: () => {}, isPanesOpen: true, panesUnreadCount: 3 });
  const panes = el.querySelector('[data-live-panes-tab="true"]') as HTMLButtonElement;
  expect(panes.getAttribute('aria-expanded')).toBe('true');
  expect(panes.className).toContain('text-primary');
  // The dot is the only reason to open the list unprompted, so it is announced.
  expect(panes.querySelector('[aria-label="3 unread replies in other panes"]')).toBeTruthy();

  const quiet = await render({ showPanesTab: true, onTogglePanes: () => {}, panesUnreadCount: 0 });
  expect(quiet.querySelector('[data-live-panes-tab="true"] [aria-label*="unread"]')).toBeNull();
});
