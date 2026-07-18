export type LiveScopedMessage = {
  messageId: string;
  paneId?: string;
  piSessionId?: string;
};

/**
 * Returns panes whose currently live Pi session changed between snapshots.
 * Drafts keyed to their old response identities must never cross this boundary.
 */
export function changedLivePaneSessionIds(
  previous: readonly LiveScopedMessage[],
  next: readonly LiveScopedMessage[],
): Set<string> {
  const previousSessions = new Map<string, string>();
  for (const message of previous) {
    if (message.paneId && message.piSessionId) previousSessions.set(message.paneId, message.piSessionId);
  }
  const changed = new Set<string>();
  for (const message of next) {
    const previousSessionId = message.paneId ? previousSessions.get(message.paneId) : undefined;
    if (message.paneId && message.piSessionId && previousSessionId && previousSessionId !== message.piSessionId) {
      changed.add(message.paneId);
    }
  }
  return changed;
}

/** Drops cached browser-only drafts belonging to panes whose Pi session changed. */
export function discardMessageStatesForChangedPanes<T>(
  states: ReadonlyMap<string, T>,
  previous: readonly LiveScopedMessage[],
  changedPaneIds: ReadonlySet<string>,
): Map<string, T> {
  if (changedPaneIds.size === 0) return new Map(states);
  const paneByMessageId = new Map(previous.map((message) => [message.messageId, message.paneId]));
  return new Map([...states].filter(([messageId]) => !changedPaneIds.has(paneByMessageId.get(messageId) ?? "")));
}
