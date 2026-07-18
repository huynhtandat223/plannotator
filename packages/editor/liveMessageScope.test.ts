import { describe, expect, test } from 'bun:test';
import {
  changedLivePaneSessionIds,
  discardMessageStatesForChangedPanes,
  type LiveScopedMessage,
} from './liveMessageScope';

const message = (messageId: string, paneId: string, piSessionId: string): LiveScopedMessage => ({
  messageId,
  paneId,
  piSessionId,
});

describe('live message session scope', () => {
  test('invalidates every retained draft for a pane when its Pi session changes', () => {
    const previous = [
      message('w:p1:old-response', 'w:p1', 'pi-session-old'),
      message('w:p2:other-response', 'w:p2', 'pi-session-stable'),
    ];
    const next = [
      message('w:p1:new-response', 'w:p1', 'pi-session-new'),
      message('w:p2:other-response', 'w:p2', 'pi-session-stable'),
    ];
    const drafts = new Map([
      ['w:p1:old-response', { draft: 'must not cross sessions' }],
      ['w:p2:other-response', { draft: 'still belongs to the active session' }],
    ]);

    const changedPaneIds = changedLivePaneSessionIds(previous, next);

    expect(changedPaneIds).toEqual(new Set(['w:p1']));
    expect(discardMessageStatesForChangedPanes(drafts, previous, changedPaneIds)).toEqual(new Map([
      ['w:p2:other-response', { draft: 'still belongs to the active session' }],
    ]));
  });

  test('does not discard drafts while a pane remains in the same Pi session', () => {
    const previous = [message('w:p1:older', 'w:p1', 'pi-session-1')];
    const next = [message('w:p1:latest', 'w:p1', 'pi-session-1')];
    const drafts = new Map([['w:p1:older', { draft: 'keep' }]]);

    const changedPaneIds = changedLivePaneSessionIds(previous, next);

    expect(changedPaneIds).toEqual(new Set());
    expect(discardMessageStatesForChangedPanes(drafts, previous, changedPaneIds)).toEqual(drafts);
  });
});
