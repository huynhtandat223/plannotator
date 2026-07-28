import { describe, expect, test } from 'bun:test';
import type { PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';
import {
  activateLiveSession,
  createLiveSessionTimelineState,
  liveSessionKey,
  markLiveSessionRepliesSeen,
  reconcileLiveSessionTimeline,
  selectLiveSessionMessage,
  stableLiveTimelineMessages,
  stableLiveSessionMessages,
  activeLiveSessionWasRemoved,
} from './liveSessionTimeline';

const message = (
  messageId: string,
  paneId: string,
  piSessionId: string | undefined,
  assistantMessageId?: string,
  extra: Partial<PickerMessage> = {},
): PickerMessage => ({
  messageId,
  paneId,
  ...(piSessionId ? { piSessionId } : {}),
  ...(assistantMessageId ? { assistantMessageId } : {}),
  text: extra.text ?? messageId,
  paneLabel: 'firstmate',
  paneTab: extra.paneTab ?? paneId,
  ...extra,
});

describe('live session timeline state', () => {
  test('uses Pi session identity, with pane identity only while registration is waiting', () => {
    expect(liveSessionKey(message('p1:r1', 'p1', 'pi-1', 'r1'))).toBe('pi:pi-1');
    expect(liveSessionKey(message('p2:waiting', 'p2', undefined))).toBe('pane:p2');

    const initial = createLiveSessionTimelineState([
      message('p1:r1', 'p1', 'pi-1', 'r1', { paneTab: 'production' }),
      message('p2:r1', 'p2', 'pi-2', 'r1', { paneTab: 'review' }),
    ], 'p2:r1');

    expect(initial.activeSessionKey).toBe('pi:pi-2');
    expect(initial.selectedMessageIdBySession).toEqual({
      'pi:pi-1': 'p1:r1',
      'pi:pi-2': 'p2:r1',
    });
  });

  test('background arrival increments only that session without navigating or replacing selection', () => {
    const previous = [
      message('p1:r1', 'p1', 'pi-1', 'r1'),
      message('p2:r1', 'p2', 'pi-2', 'r1'),
    ];
    const state = createLiveSessionTimelineState(previous, 'p1:r1');
    const next = [
      message('p1:r1', 'p1', 'pi-1', 'r1'),
      message('p2:r2', 'p2', 'pi-2', 'r2'),
      message('p2:r1', 'p2', 'pi-2', 'r1'),
    ];

    const reconciled = reconcileLiveSessionTimeline(state, previous, next);

    expect(reconciled.activeSessionKey).toBe('pi:pi-1');
    expect(reconciled.selectedMessageIdBySession['pi:pi-1']).toBe('p1:r1');
    expect(reconciled.unreadMessageIdsBySession).toEqual({ 'pi:pi-2': ['p2:r2'] });
    expect(reconciled.newReplyMessageIdsBySession).toEqual({});
  });

  test('active-session arrival becomes a non-navigating new-replies marker', () => {
    const previous = [message('p1:r1', 'p1', 'pi-1', 'r1')];
    const state = createLiveSessionTimelineState(previous, 'p1:r1');
    const next = [
      message('p1:r2', 'p1', 'pi-1', 'r2'),
      message('p1:r1', 'p1', 'pi-1', 'r1'),
    ];

    const reconciled = reconcileLiveSessionTimeline(state, previous, next);

    expect(reconciled.activeSessionKey).toBe('pi:pi-1');
    expect(reconciled.selectedMessageIdBySession['pi:pi-1']).toBe('p1:r1');
    expect(reconciled.newReplyMessageIdsBySession).toEqual({ 'pi:pi-1': ['p1:r2'] });
    expect(reconciled.unreadMessageIdsBySession).toEqual({});
  });

  test('keeps a selected synthetic waiting item when the first real response arrives', () => {
    const previous = [message('p1:waiting', 'p1', 'pi-1')];
    const state = createLiveSessionTimelineState(previous, 'p1:waiting');
    const next = [message('p1:r1', 'p1', 'pi-1', 'r1')];

    const reconciled = reconcileLiveSessionTimeline(state, previous, next);

    expect(reconciled.activeSessionKey).toBe('pi:pi-1');
    expect(reconciled.selectedMessageIdBySession['pi:pi-1']).toBe('p1:waiting');
    expect(reconciled.newReplyMessageIdsBySession['pi:pi-1']).toEqual(['p1:r1']);
  });

  test('telemetry-only frames preserve state object identity', () => {
    const previous = [message('p1:r1', 'p1', 'pi-1', 'r1', { agentStatus: 'working' })];
    const state = createLiveSessionTimelineState(previous, 'p1:r1');
    const telemetry = [message('p1:r1', 'p1', 'pi-1', 'r1', {
      agentStatus: 'idle',
      contextUsage: { tokens: 4_000, contextWindow: 10_000, percent: 40 },
      activity: { kind: 'tool', name: 'read', count: 1 },
    })];

    expect(reconcileLiveSessionTimeline(state, previous, telemetry)).toBe(state);
  });

  test('migrates a waiting pane key to its registered Pi session without navigating or losing its draft selection', () => {
    const waiting = [message('p1:waiting', 'p1', undefined)];
    const state = createLiveSessionTimelineState(waiting, 'p1:waiting');
    const registered = [message('p1:waiting', 'p1', 'pi-1')];

    const reconciled = reconcileLiveSessionTimeline(state, waiting, registered);

    expect(reconciled.activeSessionKey).toBe('pi:pi-1');
    expect(reconciled.selectedMessageIdBySession['pi:pi-1']).toBe('p1:waiting');
    expect(activeLiveSessionWasRemoved(state.activeSessionKey, waiting, registered)).toBe(false);
  });

  test('falls back only when the active session disappears and preserves its recoverable selection', () => {
    const previous = [
      message('p1:r1', 'p1', 'pi-1', 'r1'),
      message('p2:r1', 'p2', 'pi-2', 'r1'),
    ];
    const state = createLiveSessionTimelineState(previous, 'p1:r1');
    const next = [message('p2:r1', 'p2', 'pi-2', 'r1')];

    const reconciled = reconcileLiveSessionTimeline(state, previous, next);

    expect(reconciled.activeSessionKey).toBe('pi:pi-2');
    expect(reconciled.selectedMessageIdBySession['pi:pi-2']).toBe('p2:r1');
    expect(reconciled.selectedMessageIdBySession['pi:pi-1']).toBe('p1:r1');
    expect(activeLiveSessionWasRemoved(state.activeSessionKey, previous, next)).toBe(true);
  });

  test('explicit session and response selection are separate transitions', () => {
    const messages = [
      message('p1:r1', 'p1', 'pi-1', 'r1'),
      message('p2:r2', 'p2', 'pi-2', 'r2'),
      message('p2:r1', 'p2', 'pi-2', 'r1'),
    ];
    const initial = reconcileLiveSessionTimeline(
      createLiveSessionTimelineState(messages.slice(0, 2), 'p1:r1'),
      messages.slice(0, 2),
      messages,
    );
    const activated = activateLiveSession(initial, 'pi:pi-2', messages);

    expect(activated.activeSessionKey).toBe('pi:pi-2');
    expect(activated.selectedMessageIdBySession['pi:pi-2']).toBe('p2:r2');
    expect(activated.unreadMessageIdsBySession['pi:pi-2']).toBeUndefined();
    expect(activated.newReplyMessageIdsBySession['pi:pi-2']).toEqual(['p2:r1']);

    const selected = selectLiveSessionMessage(activated, messages[2]);
    expect(selected.activeSessionKey).toBe('pi:pi-2');
    expect(selected.selectedMessageIdBySession['pi:pi-2']).toBe('p2:r1');
    expect(markLiveSessionRepliesSeen(selected, 'pi:pi-2').newReplyMessageIdsBySession['pi:pi-2']).toBeUndefined();
  });
});

describe('live timeline message identity', () => {
  test('keeps one chronological session projection stable across telemetry-only frames', () => {
    const previousWire = [
      message('p1:r2', 'p1', 'pi-1', 'r2', { text: 'Newest', agentStatus: 'working' }),
      message('p1:r1', 'p1', 'pi-1', 'r1', { text: 'Oldest', agentStatus: 'working' }),
      message('p2:r1', 'p2', 'pi-2', 'r1'),
    ];
    const first = stableLiveTimelineMessages([], previousWire, 'pi:pi-1');
    const telemetryWire = [
      message('p1:r2', 'p1', 'pi-1', 'r2', { text: 'Newest', agentStatus: 'idle' }),
      message('p1:r1', 'p1', 'pi-1', 'r1', { text: 'Oldest', activity: { kind: 'tool', name: 'bash', count: 1 } }),
      message('p2:r1', 'p2', 'pi-2', 'r1', { agentStatus: 'working' }),
    ];
    const second = stableLiveTimelineMessages(first, telemetryWire, 'pi:pi-1');

    expect(first.map((item) => item.messageId)).toEqual(['p1:r1', 'p1:r2']);
    expect(second).toBe(first);
  });

  test('keeps the session switcher source stable across telemetry-only frames', () => {
    const wire = [message('p1:r1', 'p1', 'pi-1', 'r1', { agentStatus: 'working' })];
    const first = stableLiveSessionMessages([], wire);
    const telemetry = [message('p1:r1', 'p1', 'pi-1', 'r1', { agentStatus: 'idle', activity: { kind: 'tool', name: 'read', count: 1 } })];
    expect(stableLiveSessionMessages(first, telemetry)).toBe(first);
  });

  test('returns a new projection when response history changes', () => {
    const first = stableLiveTimelineMessages([], [message('p1:r1', 'p1', 'pi-1', 'r1')], 'pi:pi-1');
    const next = stableLiveTimelineMessages(first, [
      message('p1:r2', 'p1', 'pi-1', 'r2'),
      message('p1:r1', 'p1', 'pi-1', 'r1'),
    ], 'pi:pi-1');

    expect(next).not.toBe(first);
    expect(next.map((item) => item.messageId)).toEqual(['p1:r1', 'p1:r2']);
    expect(next[0]).toBe(first[0]);
  });
});
