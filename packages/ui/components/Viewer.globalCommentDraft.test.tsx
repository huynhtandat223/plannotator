/**
 * Regression guard: the live "Message Pi" global-comment draft must survive the
 * keyed Viewer remount that fires when a real assistant response replaces the
 * synthetic waiting document.
 *
 * Live panes remount the Viewer subtree by React `key` (App.tsx viewerContentKey
 * = `msg:${selectedMessageId}`) because web-highlighter mutates the Viewer DOM
 * and new content can't reconcile into the old tree. When the captain is typing
 * into the "Message Pi" composer and a real response arrives, selectedMessageId
 * flips (liveMessageScope.reconcileLiveMessageSelection forces off the waiting
 * document), remounting Viewer and — before this fix — wiping the unsent draft.
 *
 * The fix threads a pane+session-scoped `globalCommentDraftKey` into the global
 * CommentPopover so its text + images live in the module-level draftStore across
 * unmount, and re-opens the composer on remount when a draft exists so the
 * captain keeps both text AND focus.
 *
 * Mirrors how App.tsx mounts Viewer in live mode: `key={viewerContentKey}` set
 * to `msg:<id>` and `globalCommentDraftKey` scoped to `live:<pane>:<session>`.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test Viewer.globalCommentDraft
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { Block } from '../types';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in @plannotator/web-highlighter, whose UMD bundle reads `window`
// at module-eval time and throws under the default DOM-less `bun test`. Import
// lazily so this file loads cleanly when DOM tests are skipped.
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

const blocks: Block[] = [
  { id: 'b1', type: 'paragraph', content: 'hello world', order: 0, startLine: 1 },
];

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

// The live "Message Pi" composer only appears on a waiting document, so the
// Viewer is mounted with isWaiting. That renames the global button to "Message
// Pi" and swaps the empty-state prompt in.
const baseProps = {
  blocks,
  markdown: 'hello world',
  annotations: [],
  onAddAnnotation: () => {},
  onSelectAnnotation: () => {},
  selectedAnnotationId: null,
  mode: 'comment' as const,
  taterMode: false,
  isWaiting: true,
  // Host posture: no /api/doc/exists endpoint.
  disableCodePathValidation: true,
};

const DRAFT_KEY = 'live:pane-1:session-abc';

function messagePiButton(): HTMLButtonElement | null {
  return document.querySelector('button[title="Message Pi"]');
}

function composerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector('textarea');
}

// Set a controlled <textarea> value the way React expects: go through the
// native value setter, then fire a bubbling `input` event. Assigning `.value`
// directly does NOT update React state (the trap the scout hit).
async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = Object.getPrototypeOf(textarea);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Viewer live global-comment draft survives keyed remount', () => {
  test.skipIf(!hasDom)('flipping selectedMessageId (key) keeps the draft text AND reopens the composer', async () => {
    // Mount as App.tsx does in live mode: keyed by the synthetic waiting id,
    // draft scoped to pane+session.
    await mount(
      <Viewer key="msg:waiting-1" {...baseProps} globalCommentDraftKey={DRAFT_KEY} />,
    );

    // Open the composer and type an unsent message to Pi.
    await act(async () => {
      messagePiButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const textarea = composerTextarea();
    expect(textarea).not.toBeNull();
    await typeInto(textarea!, 'wait, do not merge yet');
    expect(composerTextarea()!.value).toBe('wait, do not merge yet');

    // A real assistant response arrives for this pane: reconcileLiveMessageSelection
    // forces selection off the waiting document, so viewerContentKey flips and
    // React remounts the whole Viewer subtree.
    await act(async () => {
      root!.render(
        <Viewer key="msg:response-1" {...baseProps} globalCommentDraftKey={DRAFT_KEY} />,
      );
    });

    // Composer re-opened on remount (b) and text survived (a).
    const reopened = composerTextarea();
    expect(reopened).not.toBeNull();
    expect(reopened!.value).toBe('wait, do not merge yet');
  });

  test.skipIf(!hasDom)('control: re-render WITHOUT changing key keeps the draft too', async () => {
    await mount(
      <Viewer key="msg:waiting-1" {...baseProps} globalCommentDraftKey={DRAFT_KEY} />,
    );

    await act(async () => {
      messagePiButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const textarea = composerTextarea();
    expect(textarea).not.toBeNull();
    await typeInto(textarea!, 'keep this while I think');
    expect(composerTextarea()!.value).toBe('keep this while I think');

    // Same key: no remount, just a re-render (e.g. an unrelated prop churns).
    await act(async () => {
      root!.render(
        <Viewer key="msg:waiting-1" {...baseProps} globalCommentDraftKey={DRAFT_KEY} />,
      );
    });

    const still = composerTextarea();
    expect(still).not.toBeNull();
    expect(still!.value).toBe('keep this while I think');
  });
});
