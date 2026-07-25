/**
 * Ex AI Chat option pick-list inside the live global comment box (scout v9 #6).
 *
 * Decision (Option A, data/plannotator-live-ux-scout-v9/decision-option-picklist-commit.md):
 * picking an option INSERTS its text into the composer as editable draft at the
 * cursor. It NEVER sends, and it NEVER replaces an existing draft — silently
 * destroying typed text is the same class of defect as the #1 draft wipe this
 * work exists alongside.
 *
 * These guards mount the real CommentPopover and exercise the opt-in
 * `onRequestOptions` seam:
 *   1. "Show options" fetches and renders the list; it is absent without the prop.
 *   2. Picking inserts at the cursor, preserving text on both sides (non-destructive).
 *   3. onSubmit is not called by a pick — nothing sends until the captain submits.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test CommentPopover.optionPicklist
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const hasDom = typeof document !== 'undefined';

const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover = popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(ui);
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

const anchorRect = { top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20, x: 100, y: 100 } as DOMRect;

function composerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector('textarea');
}

function showOptionsButton(): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Show options',
  ) as HTMLButtonElement | undefined) ?? null;
}

function optionButtons(): HTMLButtonElement[] {
  const list = document.querySelector('[aria-label="Ex AI Chat options (inserts for editing)"]');
  if (!list) return [];
  return Array.from(list.querySelectorAll('button'));
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = Object.getPrototypeOf(textarea);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const baseProps = {
  anchorRect,
  contextText: '',
  isGlobal: true as const,
  onClose: () => {},
};

describe('CommentPopover Ex AI Chat option pick-list', () => {
  test.skipIf(!hasDom)('the Show options action is absent when onRequestOptions is not provided', async () => {
    await mount(<CommentPopover {...baseProps} onSubmit={() => {}} />);
    expect(showOptionsButton()).toBeNull();
  });

  test.skipIf(!hasDom)('picking an option inserts editable draft text and does not send', async () => {
    let submitted = false;
    await mount(
      <CommentPopover
        {...baseProps}
        onSubmit={() => { submitted = true; }}
        onRequestOptions={async () => ['Yes, proceed with the migration.', 'No, hold off for now.']}
      />,
    );

    await act(async () => {
      showOptionsButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const options = optionButtons();
    expect(options.length).toBe(2);

    await act(async () => {
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Text is inserted as draft, and nothing was sent.
    expect(composerTextarea()!.value).toContain('Yes, proceed with the migration.');
    expect(submitted).toBe(false);
    // List closes after a pick.
    expect(optionButtons().length).toBe(0);
  });

  test.skipIf(!hasDom)('a pick never replaces an existing draft — it inserts at the cursor', async () => {
    await mount(
      <CommentPopover
        {...baseProps}
        onSubmit={() => {}}
        onRequestOptions={async () => ['inserted option text']}
      />,
    );

    const textarea = composerTextarea()!;
    await typeInto(textarea, 'my own words');
    // Cursor at the end of the typed draft.
    await act(async () => {
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    });

    await act(async () => {
      showOptionsButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      optionButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const value = composerTextarea()!.value;
    // The typed draft is preserved AND the option is present.
    expect(value).toContain('my own words');
    expect(value).toContain('inserted option text');
    expect(value.indexOf('my own words')).toBeLessThan(value.indexOf('inserted option text'));
  });

  test.skipIf(!hasDom)('the list is keyboard-navigable: ArrowDown + Enter picks, Esc dismisses', async () => {
    await mount(
      <CommentPopover
        {...baseProps}
        onSubmit={() => {}}
        onRequestOptions={async () => ['first option', 'second option']}
      />,
    );

    await act(async () => {
      showOptionsButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(optionButtons().length).toBe(2);

    const textarea = composerTextarea()!;
    const fireKey = async (key: string) => {
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    };

    // Move to the second option, then Enter to pick it.
    await fireKey('ArrowDown');
    await fireKey('Enter');
    expect(composerTextarea()!.value).toContain('second option');
    // List closes after the keyboard pick.
    expect(optionButtons().length).toBe(0);

    // Re-open, then Esc dismisses the list without touching the draft.
    await act(async () => {
      showOptionsButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(optionButtons().length).toBe(2);
    const before = composerTextarea()!.value;
    await fireKey('Escape');
    expect(optionButtons().length).toBe(0);
    expect(composerTextarea()!.value).toBe(before);
  });
});
