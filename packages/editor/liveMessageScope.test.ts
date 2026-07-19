import { describe, expect, test } from 'bun:test';
import {
  changedLivePaneSessionIds,
  discardMessageStatesForChangedPanes,
  reconcileLiveMessageSelection,
  type LiveScopedMessage,
} from './liveMessageScope';

const message = (messageId: string, paneId: string, piSessionId: string, assistantMessageId?: string): LiveScopedMessage => ({
  messageId,
  paneId,
  piSessionId,
  assistantMessageId,
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

  test('recognizes a pane session transition only once after its new snapshot is accepted', () => {
    const oldSnapshot = [message('w:p1:old-response', 'w:p1', 'pi-session-old')];
    const newSnapshot = [message('w:p1:new-response', 'w:p1', 'pi-session-new')];

    expect(changedLivePaneSessionIds(oldSnapshot, newSnapshot)).toEqual(new Set(['w:p1']));
    // Repeated SSE events contain the same accepted snapshot. They must not
    // be treated as another session replacement or produce another warning.
    expect(changedLivePaneSessionIds(newSnapshot, newSnapshot)).toEqual(new Set());
  });

  test('reconciles selection off a synthetic waiting document when a real assistant response arrives', () => {
    const previous = [
      message('w:p1:waiting', 'w:p1', 'session-1'), // waiting document (no assistantMessageId)
    ];
    const next = [
      message('w:p1:pi-msg-123', 'w:p1', 'session-1', 'pi-msg-123'), // real response (has assistantMessageId)
    ];

    const result = reconcileLiveMessageSelection(
      previous,
      next,
      'w:p1:waiting',
      'w:p1:pi-msg-123',
      null
    );

    expect(result.nextSelectedMessageId).toBe('w:p1:pi-msg-123');
    expect(result.followNextPaneResponseReset).toBe(false);
  });

  test('returns followed message if pane received a new response', () => {
    const previous = [message('w:p1:response-1', 'w:p1', 'session-1', 'response-1')];
    const next = [
      message('w:p1:response-2', 'w:p1', 'session-1', 'response-2'),
    ];
    const follow = { paneId: 'w:p1', latestMessageId: 'w:p1:response-1' };

    const result = reconcileLiveMessageSelection(
      previous,
      next,
      'w:p1:response-1',
      'w:p1:response-2',
      follow
    );

    expect(result.nextSelectedMessageId).toBe('w:p1:response-2');
    expect(result.followNextPaneResponseReset).toBe(true);
  });

  test('follows Herdr’s focused-pane selection until the reviewer picks a source', () => {
    const previous = [message('w:p1:response-1', 'w:p1', 'session-1', 'response-1')];
    const next = [
      message('w:p1:response-1', 'w:p1', 'session-1', 'response-1'),
      message('w:p2:response-1', 'w:p2', 'session-2', 'response-1'),
    ];

    const result = reconcileLiveMessageSelection(
      previous,
      next,
      'w:p1:response-1',
      'w:p2:response-1',
      null,
    );

    expect(result.nextSelectedMessageId).toBe('w:p2:response-1');
  });

  test('follows the focus transition from a waiting pane to a structured response in another pane before user selection', () => {
    const previous = [message('w:p7:waiting', 'w:p7', 'session-7')];
    const next = [
      message('w:p1:response-1', 'w:p1', 'session-1', 'response-1'),
      message('w:p7:waiting', 'w:p7', 'session-7'),
    ];

    expect(reconcileLiveMessageSelection(
      previous,
      next,
      'w:p7:waiting',
      'w:p1:response-1',
      null,
    )).toEqual({ nextSelectedMessageId: 'w:p1:response-1', followNextPaneResponseReset: false });
  });

  test('keeps an explicitly selected source when Herdr focus changes', () => {
    const previous = [message('w:p1:response-1', 'w:p1', 'session-1', 'response-1')];
    const next = [
      message('w:p1:response-1', 'w:p1', 'session-1', 'response-1'),
      message('w:p2:response-1', 'w:p2', 'session-2', 'response-1'),
    ];

    const result = reconcileLiveMessageSelection(
      previous,
      next,
      'w:p1:response-1',
      'w:p2:response-1',
      null,
      true,
    );

    expect(result.nextSelectedMessageId).toBe('w:p1:response-1');
  });
});
