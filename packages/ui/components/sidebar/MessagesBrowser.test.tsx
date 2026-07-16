import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessagesBrowser } from './MessagesBrowser';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

test.skipIf(!hasDom)('renders an accessible chronological response picker with a selected newest response', async () => {
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
  const buttons = host.querySelectorAll('button');
  expect(buttons).toHaveLength(2);
  expect(buttons[1].getAttribute('aria-current')).toBe('true');
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  expect(buttons[1].textContent).toContain('★');
});

test.skipIf(!hasDom)('renders an accessible empty response state', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MessagesBrowser messages={[]} selectedMessageId={null} onSelect={() => {}} />);
  });

  expect(host.textContent).toContain('No recent assistant responses available yet.');
});
