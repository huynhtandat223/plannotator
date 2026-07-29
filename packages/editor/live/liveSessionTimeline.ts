import type { PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';

export type LiveSessionKey = `pi:${string}` | `pane:${string}`;

export type LiveSessionTimelineState = {
  activeSessionKey: LiveSessionKey | null;
  selectedMessageIdBySession: Record<string, string>;
  unreadMessageIdsBySession: Record<string, string[]>;
  newReplyMessageIdsBySession: Record<string, string[]>;
};

export function liveSessionKey(message: Pick<PickerMessage, 'piSessionId' | 'paneId'>): LiveSessionKey | null {
  if (message.piSessionId) return `pi:${message.piSessionId}`;
  return message.paneId ? `pane:${message.paneId}` : null;
}

function sessionKeys(messages: readonly PickerMessage[]): LiveSessionKey[] {
  const result: LiveSessionKey[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const key = liveSessionKey(message);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

function newestMessageId(messages: readonly PickerMessage[], key: LiveSessionKey): string | undefined {
  return messages.find((message) => liveSessionKey(message) === key)?.messageId;
}

/**
 * A panel begins life without an extension session id (`pane:<id>`), then gains
 * one once Pi registers (`pi:<id>`). That is identity enrichment, not a new
 * captain navigation target, so transfer local state to the canonical key.
 */
function fallbackSessionMigrations(
  previous: readonly PickerMessage[],
  next: readonly PickerMessage[],
): Map<LiveSessionKey, LiveSessionKey> {
  const migrations = new Map<LiveSessionKey, LiveSessionKey>();
  for (const message of previous) {
    const oldKey = liveSessionKey(message);
    if (!oldKey?.startsWith('pane:') || !message.paneId) continue;
    const registered = next.find((candidate) => candidate.paneId === message.paneId && candidate.piSessionId);
    if (registered) migrations.set(oldKey, liveSessionKey(registered)!);
  }
  return migrations;
}

function migrateStringRecord(
  record: Record<string, string>,
  migrations: ReadonlyMap<LiveSessionKey, LiveSessionKey>,
): Record<string, string> {
  let next = record;
  for (const [from, to] of migrations) {
    const value = next[from];
    if (!value || from === to) continue;
    const copy = { ...next };
    delete copy[from];
    if (!copy[to]) copy[to] = value;
    next = copy;
  }
  return next;
}

function migrateListRecord(
  record: Record<string, string[]>,
  migrations: ReadonlyMap<LiveSessionKey, LiveSessionKey>,
): Record<string, string[]> {
  let next = record;
  for (const [from, to] of migrations) {
    const values = next[from];
    if (!values || from === to) continue;
    const copy = { ...next };
    delete copy[from];
    copy[to] = [...new Set([...(copy[to] ?? []), ...values])];
    next = copy;
  }
  return next;
}

function withList(
  record: Record<string, string[]>,
  key: LiveSessionKey,
  values: readonly string[],
): Record<string, string[]> {
  const unique = [...new Set(values)];
  if (unique.length === 0) {
    if (!(key in record)) return record;
    const next = { ...record };
    delete next[key];
    return next;
  }
  const current = record[key];
  if (current?.length === unique.length && current.every((value, index) => value === unique[index])) return record;
  return { ...record, [key]: unique };
}

export function createLiveSessionTimelineState(
  messages: readonly PickerMessage[],
  initialSelectedMessageId: string | null,
): LiveSessionTimelineState {
  const keys = sessionKeys(messages);
  const selectedMessage = messages.find((message) => message.messageId === initialSelectedMessageId);
  const activeSessionKey = (selectedMessage && liveSessionKey(selectedMessage)) || keys[0] || null;
  const selectedMessageIdBySession: Record<string, string> = {};
  for (const key of keys) {
    const selected = selectedMessage && liveSessionKey(selectedMessage) === key
      ? selectedMessage.messageId
      : newestMessageId(messages, key);
    if (selected) selectedMessageIdBySession[key] = selected;
  }
  return {
    activeSessionKey,
    selectedMessageIdBySession,
    unreadMessageIdsBySession: {},
    newReplyMessageIdsBySession: {},
  };
}

/**
 * Accepts a complete live snapshot without treating host focus as navigation.
 * Only response-history changes affect this state; telemetry-only frames return
 * the exact same object so the memoized active timeline does not re-render.
 */
export function reconcileLiveSessionTimeline(
  state: LiveSessionTimelineState,
  previousMessages: readonly PickerMessage[],
  nextMessages: readonly PickerMessage[],
): LiveSessionTimelineState {
  const migrations = fallbackSessionMigrations(previousMessages, nextMessages);
  const nextKeys = sessionKeys(nextMessages);
  const nextKeySet = new Set(nextKeys);
  let activeSessionKey = state.activeSessionKey && migrations.get(state.activeSessionKey)
    ? migrations.get(state.activeSessionKey)!
    : state.activeSessionKey;
  if (!activeSessionKey || !nextKeySet.has(activeSessionKey)) activeSessionKey = nextKeys[0] ?? null;

  let selectedMessageIdBySession = migrateStringRecord(state.selectedMessageIdBySession, migrations);
  for (const key of nextKeys) {
    if (selectedMessageIdBySession[key]) continue;
    const messageId = newestMessageId(nextMessages, key);
    if (messageId) selectedMessageIdBySession = { ...selectedMessageIdBySession, [key]: messageId };
  }

  const previousIds = new Set(previousMessages.map((message) => message.messageId));
  const arrivalsBySession = new Map<LiveSessionKey, string[]>();
  for (const message of nextMessages) {
    if (!message.assistantMessageId || previousIds.has(message.messageId)) continue;
    const key = liveSessionKey(message);
    if (!key) continue;
    const arrivals = arrivalsBySession.get(key) ?? [];
    arrivals.push(message.messageId);
    arrivalsBySession.set(key, arrivals);
  }

  let unreadMessageIdsBySession = migrateListRecord(state.unreadMessageIdsBySession, migrations);
  let newReplyMessageIdsBySession = migrateListRecord(state.newReplyMessageIdsBySession, migrations);
  for (const [key, arrivals] of arrivalsBySession) {
    if (key === activeSessionKey) {
      newReplyMessageIdsBySession = withList(
        newReplyMessageIdsBySession,
        key,
        [...(newReplyMessageIdsBySession[key] ?? []), ...arrivals],
      );
    } else {
      unreadMessageIdsBySession = withList(
        unreadMessageIdsBySession,
        key,
        [...(unreadMessageIdsBySession[key] ?? []), ...arrivals],
      );
    }
  }

  if (
    activeSessionKey === state.activeSessionKey &&
    selectedMessageIdBySession === state.selectedMessageIdBySession &&
    unreadMessageIdsBySession === state.unreadMessageIdsBySession &&
    newReplyMessageIdsBySession === state.newReplyMessageIdsBySession
  ) return state;

  return {
    activeSessionKey,
    selectedMessageIdBySession,
    unreadMessageIdsBySession,
    newReplyMessageIdsBySession,
  };
}

/** True only when the previously displayed physical session has disappeared.
 * A `pane:` → `pi:` key migration is identity enrichment and deliberately false. */
export function activeLiveSessionWasRemoved(
  activeSessionKey: LiveSessionKey | null,
  previousMessages: readonly PickerMessage[],
  nextMessages: readonly PickerMessage[],
): boolean {
  if (!activeSessionKey) return false;
  if (nextMessages.some((message) => liveSessionKey(message) === activeSessionKey)) return false;
  const migrated = fallbackSessionMigrations(previousMessages, nextMessages).get(activeSessionKey);
  return migrated === undefined;
}

export function activateLiveSession(
  state: LiveSessionTimelineState,
  key: LiveSessionKey,
  messages: readonly PickerMessage[],
): LiveSessionTimelineState {
  if (!messages.some((message) => liveSessionKey(message) === key)) return state;
  let selectedMessageIdBySession = state.selectedMessageIdBySession;
  if (!selectedMessageIdBySession[key]) {
    const messageId = newestMessageId(messages, key);
    if (messageId) selectedMessageIdBySession = { ...selectedMessageIdBySession, [key]: messageId };
  }
  const unread = state.unreadMessageIdsBySession[key] ?? [];
  const unreadMessageIdsBySession = withList(state.unreadMessageIdsBySession, key, []);
  const newReplyMessageIdsBySession = withList(
    state.newReplyMessageIdsBySession,
    key,
    [...(state.newReplyMessageIdsBySession[key] ?? []), ...unread],
  );
  if (
    state.activeSessionKey === key &&
    selectedMessageIdBySession === state.selectedMessageIdBySession &&
    unreadMessageIdsBySession === state.unreadMessageIdsBySession &&
    newReplyMessageIdsBySession === state.newReplyMessageIdsBySession
  ) return state;
  return { activeSessionKey: key, selectedMessageIdBySession, unreadMessageIdsBySession, newReplyMessageIdsBySession };
}

export function selectLiveSessionMessage(
  state: LiveSessionTimelineState,
  message: PickerMessage,
): LiveSessionTimelineState {
  const key = liveSessionKey(message);
  if (!key || key !== state.activeSessionKey || state.selectedMessageIdBySession[key] === message.messageId) return state;
  return {
    ...state,
    selectedMessageIdBySession: { ...state.selectedMessageIdBySession, [key]: message.messageId },
  };
}

export function markLiveSessionRepliesSeen(
  state: LiveSessionTimelineState,
  key: LiveSessionKey,
): LiveSessionTimelineState {
  const newReplyMessageIdsBySession = withList(state.newReplyMessageIdsBySession, key, []);
  return newReplyMessageIdsBySession === state.newReplyMessageIdsBySession
    ? state
    : { ...state, newReplyMessageIdsBySession };
}

const sameTimelineMessage = (left: PickerMessage, right: PickerMessage): boolean =>
  left.messageId === right.messageId &&
  left.text === right.text &&
  left.timestamp === right.timestamp &&
  left.label === right.label &&
  left.assistantMessageId === right.assistantMessageId &&
  left.paneId === right.paneId &&
  left.piSessionId === right.piSessionId &&
  left.isExAICompanion === right.isExAICompanion;

function stableMessageProjection(
  previous: readonly PickerMessage[],
  nextWire: readonly PickerMessage[],
): PickerMessage[] {
  if (
    previous.length === nextWire.length &&
    previous.every((message, index) => sameTimelineMessage(message, nextWire[index]))
  ) return previous as PickerMessage[];

  const previousById = new Map(previous.map((message) => [message.messageId, message]));
  return nextWire.map((message) => {
    const retained = previousById.get(message.messageId);
    return retained && sameTimelineMessage(retained, message) ? retained : message;
  });
}

/**
 * Stable newest-first live-session sources for the switcher. Telemetry is
 * intentionally excluded from `sameTimelineMessage`, so SSE status/tool churn
 * cannot remount either the switcher or its active transcript.
 */
export function stableLiveSessionMessages(
  previous: readonly PickerMessage[],
  wireMessages: readonly PickerMessage[],
): PickerMessage[] {
  return stableMessageProjection(previous, wireMessages);
}

/**
 * Newest-first active-session projection with stable identity across
 * telemetry-only frames.
 *
 * The newest response is the one the captain opened the panel for, so it leads
 * the transcript rather than sitting at the bottom of it. That is a real DOM
 * order — not a visual reversal — so reading order, tab order and the
 * assistive reading of the list all agree, and the wire (already newest-first)
 * needs no reversal at all.
 */
export function stableLiveTimelineMessages(
  previous: readonly PickerMessage[],
  wireMessages: readonly PickerMessage[],
  key: LiveSessionKey | null,
): PickerMessage[] {
  if (!key) return previous.length === 0 ? previous as PickerMessage[] : [];
  return stableMessageProjection(previous, wireMessages.filter((message) => liveSessionKey(message) === key));
}
