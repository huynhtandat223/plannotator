import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessagesBrowser } from './MessagesBrowser';
import { resetStorageBackend, setStorageBackend } from '../../utils/storage';

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
