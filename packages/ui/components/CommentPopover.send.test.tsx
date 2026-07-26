/** DOM guards for Global Comment's one-click Send action. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const hasDom = typeof document !== 'undefined';
const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover = popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

let root: Root | null = null;
let host: HTMLElement | null = null;
const anchorRect = { top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20, x: 100, y: 100 } as DOMRect;

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(ui);
  });
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined) ?? null;
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('CommentPopover global Send', () => {
  test.skipIf(!hasDom)('global comments hide Ask AI and Send calls the delivery callback', async () => {
    const calls: string[] = [];
    await mount(
      <CommentPopover
        anchorRect={anchorRect}
        contextText=""
        isGlobal
        onSubmit={() => { calls.push('submit'); }}
        onSend={async (text) => { calls.push(text); return true; }}
        onAskAI={() => { calls.push('ask-ai'); }}
        onClose={() => {}}
      />,
    );

    expect(button('Ask AI')).toBeNull();
    expect(button('Add')).toBeNull();
    expect(button('Send')).not.toBeNull();
    expect(button('Send')!.disabled).toBe(true);

    await typeInto(document.querySelector('textarea')!, 'Ship this directly');
    expect(button('Send')!.disabled).toBe(false);
    await act(async () => {
      button('Send')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(calls).toEqual(['Ship this directly']);
  });

  test.skipIf(!hasDom)('accepted Send closes once, clears the keyed draft, and restores anchor focus', async () => {
    let closeCount = 0;
    const anchor = document.createElement('button');
    anchor.textContent = 'Open Global Comment';
    document.body.appendChild(anchor);

    const renderPopover = () => (
      <CommentPopover
        anchorEl={anchor}
        contextText=""
        isGlobal
        draftKey="live:pane-1:session-1"
        onSubmit={() => {}}
        onSend={async () => true}
        onClose={() => {
          closeCount += 1;
          root!.render(null);
        }}
      />
    );

    await mount(renderPopover());
    await typeInto(document.querySelector('textarea')!, 'Ship this directly');
    button('Send')!.focus();
    await act(async () => button('Send')!.click());
    await nextFrame();

    expect(closeCount).toBe(1);
    expect(document.querySelector('[data-comment-popover="true"]')).toBeNull();
    expect(document.activeElement).toBe(anchor);

    await act(async () => root!.render(renderPopover()));
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  for (const [label, onSend] of [
    ['false', async () => false],
    ['rejection', async () => { throw new Error('not accepted'); }],
  ] as const) {
    test.skipIf(!hasDom)(`${label} keeps the keyed draft open and focuses the textarea`, async () => {
      let closeCount = 0;
      const anchor = document.createElement('button');
      anchor.textContent = 'Open Global Comment';
      document.body.appendChild(anchor);
      await mount(
        <CommentPopover
          anchorEl={anchor}
          contextText=""
          isGlobal
          draftKey={`live:pane-2:session-${label}`}
          onSubmit={() => {}}
          onSend={onSend}
          onClose={() => { closeCount += 1; }}
        />,
      );

      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      await typeInto(textarea, 'Keep this for retry');
      await act(async () => document.querySelector<HTMLButtonElement>('button[title="Attachments"]')!.click());
      const pathInput = document.querySelector<HTMLInputElement>('input[placeholder="Paste path or URL..."]')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pathInput), 'value')?.set;
        setter?.call(pathInput, '/tmp/retry-image.png');
        pathInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => button('Add')!.click());
      button('Send')!.focus();
      const consoleError = label === 'rejection'
        ? spyOn(console, 'error').mockImplementation(() => {})
        : null;
      await act(async () => button('Send')!.click());

      expect(closeCount).toBe(0);
      if (consoleError) {
        expect(consoleError).toHaveBeenCalledTimes(1);
        consoleError.mockRestore();
      }
      expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();
      expect(textarea.value).toBe('Keep this for retry');
      expect(document.querySelector('img[alt="retry-image"]')).not.toBeNull();
      expect(document.activeElement).toBe(textarea);
    });
  }

  test.skipIf(!hasDom)('Send requires text and is disabled while delivery is in flight', async () => {
    await mount(
      <CommentPopover
        anchorRect={anchorRect}
        contextText=""
        isGlobal
        onSubmit={() => {}}
        onSend={() => true}
        isSending
        onClose={() => {}}
      />,
    );
    await typeInto(document.querySelector('textarea')!, 'ready');
    expect(button('Sending...')).not.toBeNull();
    expect(button('Sending...')!.disabled).toBe(true);
  });

  test.skipIf(!hasDom)('global comments without direct delivery still hide Ask AI and keep Add', async () => {
    await mount(
      <CommentPopover
        anchorRect={anchorRect}
        contextText=""
        isGlobal
        onSubmit={() => {}}
        onAskAI={() => {}}
        onClose={() => {}}
      />,
    );
    expect(button('Ask AI')).toBeNull();
    expect(button('Add')).not.toBeNull();
  });

  test.skipIf(!hasDom)('non-global comments keep Ask AI and Save', async () => {
    await mount(
      <CommentPopover
        anchorRect={anchorRect}
        contextText="selected code"
        isGlobal={false}
        onSubmit={() => {}}
        onAskAI={() => {}}
        onClose={() => {}}
      />,
    );

    expect(button('Ask AI')).not.toBeNull();
    expect(button('Save')).not.toBeNull();
    expect(button('Send')).toBeNull();
  });
});
