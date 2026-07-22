import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessagesBrowser } from './MessagesBrowser';
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

test.skipIf(!hasDom)('collapses to the default count and expands via the toggle', async () => {
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

  // Default count is 3 → 3 rows shown + 1 toggle button.
  const toggle = Array.from(host.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('Show 3 older'),
  );
  expect(toggle).toBeTruthy();
  expect(host.textContent).toContain('Response 3');
  expect(host.textContent).not.toContain('Response 4');

  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

test.skipIf(!hasDom)('caps the visible count per herd, not across the whole list', async () => {
  useMemoryStorage();
  setMessagePickerCount('1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser
      messages={[
        { messageId: 'a1', text: 'alpha latest', paneId: 'p1', paneLabel: 'alpha-herd', workspaceId: 'ws-a' },
        { messageId: 'a2', text: 'alpha older', paneId: 'p1', paneLabel: 'alpha-herd', workspaceId: 'ws-a' },
        { messageId: 'b1', text: 'beta latest', paneId: 'p2', paneLabel: 'beta-herd', workspaceId: 'ws-b' },
        { messageId: 'b2', text: 'beta older', paneId: 'p2', paneLabel: 'beta-herd', workspaceId: 'ws-b' },
      ]}
      selectedMessageId="a1"
      onSelect={() => {}}
    />);
  });

  // Show 1 → one latest response per herd (both herds keep their first row).
  expect(host.textContent).toContain('alpha latest');
  expect(host.textContent).toContain('beta latest');
  expect(host.textContent).not.toContain('alpha older');
  expect(host.textContent).not.toContain('beta older');
  // 2 shown rows + 1 "Show older" toggle.
  expect(host.querySelectorAll('button')).toHaveLength(3);
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
