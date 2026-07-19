/**
 * Consumer-surface contract for Viewer's host props:
 *   - readOnly suppresses the composer entry points (global-comment button,
 *     attachments) while the document still renders
 *   - allowImages threads to CommentPopover, which hides its attach affordance
 * Defaults preserve today's behavior (composer on, images on).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { AnnotationType, type Annotation, type Block } from '../types';

const hasDom = typeof document !== 'undefined';

// Viewer pulls in @plannotator/web-highlighter, whose UMD bundle reads
// `window` at module-eval time and throws under the default DOM-less
// `bun test`. Import lazily so this file loads cleanly when DOM tests are
// skipped; DOM_TESTS=1 supplies a real DOM and the real modules.
const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];
const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover =
  popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

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

const viewerProps = {
  blocks,
  markdown: 'hello world',
  annotations: [],
  onAddAnnotation: () => {},
  onSelectAnnotation: () => {},
  selectedAnnotationId: null,
  mode: 'comment' as const,
  taterMode: false,
  // Host posture: no /api/doc/exists endpoint.
  disableCodePathValidation: true,
};

function globalCommentButton(): Element | null {
  return document.querySelector('button[title="Add global comment"]');
}

describe('Viewer consumer props', () => {
  test.skipIf(!hasDom)('default renders the global-comment composer entry (today’s behavior)', async () => {
    await mount(
      <Viewer
        {...viewerProps}
        onAddGlobalAttachment={() => {}}
        onRemoveGlobalAttachment={() => {}}
      />,
    );
    expect(globalCommentButton()).not.toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).not.toBeNull();
    expect(document.body.textContent).toContain('hello world');
  });

  test.skipIf(!hasDom)('readOnly hides composer entry points but still renders the document', async () => {
    await mount(
      <Viewer
        {...viewerProps}
        readOnly
        onAddGlobalAttachment={() => {}}
        onRemoveGlobalAttachment={() => {}}
      />,
    );
    expect(globalCommentButton()).toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();
    expect(document.body.textContent).toContain('hello world');
  });

  test.skipIf(!hasDom)('waiting message panes hide image attachments because instructions are text-only', async () => {
    await mount(
      <Viewer
        {...viewerProps}
        isWaiting
        onAddGlobalAttachment={() => {}}
        onRemoveGlobalAttachment={() => {}}
      />,
    );
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();
  });

  test.skipIf(!hasDom)('restores server-loaded comment annotations as yellow comment highlights', async () => {
    const annotation: Annotation = {
      id: 'server-comment',
      blockId: 'b1',
      startOffset: 0,
      endOffset: 5,
      type: AnnotationType.COMMENT,
      text: 'Clarify this',
      originalText: 'hello',
      createdA: Date.now(),
    };

    await mount(<Viewer {...viewerProps} />);
    await act(async () => {
      root!.render(<Viewer {...viewerProps} annotations={[annotation]} />);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const mark = [...document.querySelectorAll<HTMLElement>('mark.annotation-highlight')]
      .find((element) => element.textContent === 'hello');
    expect(mark).toBeDefined();
    expect(mark?.classList.contains('comment')).toBe(true);
    expect(mark?.getAttribute('data-bind-id')).toBe(annotation.id);
  });
});

describe('CommentPopover allowImages', () => {
  function makeAnchor(): HTMLElement {
    const el = document.createElement('span');
    el.textContent = 'anchor';
    document.body.appendChild(el);
    return el;
  }
  const popoverProps = {
    contextText: 'ctx',
    isGlobal: true,
    onSubmit: () => {},
    onClose: () => {},
  };

  test.skipIf(!hasDom)('default shows the attach affordance', async () => {
    await mount(<CommentPopover {...popoverProps} anchorEl={makeAnchor()} />);
    expect(document.querySelector('button[title="Attachments"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('allowImages={false} hides the attach affordance', async () => {
    await mount(<CommentPopover {...popoverProps} anchorEl={makeAnchor()} allowImages={false} />);
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();
  });

  test.skipIf(!hasDom)('submit with allowImages={false} never reports images', async () => {
    const submitted: Array<unknown> = [];
    await mount(
      <CommentPopover
        {...popoverProps}
        anchorEl={makeAnchor()}
        allowImages={false}
        onSubmit={(text, images) => submitted.push({ text, images })}
      />,
    );
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const proto = Object.getPrototypeOf(textarea);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(textarea, 'a comment');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
      );
    });
    expect(submitted).toEqual([{ text: 'a comment', images: undefined }]);
  });

  test.skipIf(!hasDom)('offers and explicitly runs a selected live Pi command without submitting it as a comment', async () => {
    const submitted: Array<unknown> = [];
    const runCalls: Array<unknown> = [];
    await mount(
      <CommentPopover
        {...popoverProps}
        anchorEl={makeAnchor()}
        livePiCommands={[{ name: 'handoff', description: 'Create a handoff', source: 'extension' }]}
        onSubmit={(text, images) => submitted.push({ text, images })}
        onRunLivePiCommand={async (command, args) => { runCalls.push({ command, args }); }}
      />,
    );
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const proto = Object.getPrototypeOf(textarea);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(textarea, '/han');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const suggestion = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('/handoff'));
    expect(suggestion).toBeDefined();
    await act(async () => { suggestion?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {
      const proto = Object.getPrototypeOf(textarea);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(textarea, '/handoff summary');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const runButton = Array.from(document.querySelectorAll('button')).find((button) => button.title === 'Run /handoff in Pi');
    expect(runButton).toBeDefined();
    await act(async () => { runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(runCalls).toEqual([{ command: 'handoff', args: 'summary' }]);
    expect(submitted).toEqual([]);
  });

  test.skipIf(!hasDom)('keeps typed slash text as a normal comment until a command is selected', async () => {
    const submitted: Array<unknown> = [];
    await mount(
      <CommentPopover
        {...popoverProps}
        anchorEl={makeAnchor()}
        livePiCommands={[{ name: 'handoff', source: 'extension' }]}
        onRunLivePiCommand={async () => { throw new Error('must not run'); }}
        onSubmit={(text, images) => submitted.push({ text, images })}
      />,
    );
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const proto = Object.getPrototypeOf(textarea);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(textarea, '/not-a-command');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    expect(submitted).toEqual([{ text: '/not-a-command', images: undefined }]);
  });
});

// Keep the import shape honest: AnnotationType is part of the tested surface.
void AnnotationType;
