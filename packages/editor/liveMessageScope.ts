export type LiveScopedMessage = {
  messageId: string;
  paneId?: string;
  piSessionId?: string;
  assistantMessageId?: string;
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

/**
 * Reconciles the selection for live messages, ensuring we switch off of synthetic waiting documents
 * when real assistant messages arrive, and handling pane changes correctly.
 */
export function reconcileLiveMessageSelection(
  previousMessages: readonly LiveScopedMessage[],
  nextMessages: readonly LiveScopedMessage[],
  currentSelectedMessageId: string | null,
  snapshotSelectedMessageId: string | null,
  followNextPaneResponse: { paneId: string; latestMessageId: string } | null,
  /** A reviewer-selected source must remain stable across live snapshots. */
  hasUserSelectedMessage = false,
): {
  nextSelectedMessageId: string | null;
  followNextPaneResponseReset: boolean;
  /**
   * A newer response became focused in a different pane while the reviewer was
   * already viewing a real response. The caller keeps the current view and
   * surfaces this as a notification instead of yanking to the other pane.
   */
  pendingFocusMessageId?: string | null;
} {
  const selectedPaneId = previousMessages.find((message) => message.messageId === currentSelectedMessageId)?.paneId;
  const changedPaneIds = changedLivePaneSessionIds(previousMessages, nextMessages);
  const selectedPaneSessionChanged = changedPaneIds.has(selectedPaneId ?? "");

  const followedPaneLatest = followNextPaneResponse
    ? nextMessages.find((message) => message.paneId === followNextPaneResponse.paneId)
    : null;
  const receivedFollowedResponse = followedPaneLatest !== null &&
    followedPaneLatest.messageId !== followNextPaneResponse?.latestMessageId;

  if (receivedFollowedResponse && followedPaneLatest) {
    return {
      nextSelectedMessageId: followedPaneLatest.messageId,
      followNextPaneResponseReset: true,
    };
  }

  // If currently selected message is a synthetic waiting document (ends with ':waiting' or has no assistantMessageId),
  // and there is a real response (with an assistantMessageId) in the next snapshot for the same pane,
  // we must transition to that real response.
  const currentMessage = previousMessages.find((m) => m.messageId === currentSelectedMessageId);
  const isCurrentlyWaiting = currentSelectedMessageId?.endsWith(":waiting") || (currentMessage && !currentMessage.assistantMessageId);

  if (isCurrentlyWaiting && selectedPaneId) {
    const realResponse = nextMessages.find((m) => m.paneId === selectedPaneId && m.assistantMessageId);
    if (realResponse) {
      return {
        nextSelectedMessageId: realResponse.messageId,
        followNextPaneResponseReset: false,
      };
    }
  }

  // Before a reviewer explicitly picks a source, follow the server's selected
  // live pane. That selection is Herdr's focused-pane truth; retaining the
  // initial /api/plan source after focus changed makes the viewer's content
  // and feedback target silently diverge.
  //
  // Exception: once the reviewer is already viewing a real structured response,
  // a focus change to a *different* pane must not yank the view out from under
  // them (a completed response in another pane should not steal the tab). In
  // that case keep the current selection and report the focused message so the
  // caller can surface a notification the reviewer can act on when ready.
  if (!hasUserSelectedMessage && snapshotSelectedMessageId !== null && nextMessages.some((message) => message.messageId === snapshotSelectedMessageId)) {
    const snapshotSelectedPaneId = nextMessages.find((message) => message.messageId === snapshotSelectedMessageId)?.paneId;
    const focusMovedToAnotherPane = selectedPaneId !== undefined && snapshotSelectedPaneId !== selectedPaneId;
    if (!isCurrentlyWaiting && focusMovedToAnotherPane) {
      return {
        nextSelectedMessageId: currentSelectedMessageId,
        followNextPaneResponseReset: false,
        pendingFocusMessageId: snapshotSelectedMessageId,
      };
    }
    return {
      nextSelectedMessageId: snapshotSelectedMessageId,
      followNextPaneResponseReset: false,
    };
  }

  // Normal selection reconciliation logic
  let nextSelectedId: string | null = null;
  if (selectedPaneSessionChanged) {
    nextSelectedId = nextMessages.find((message) => message.paneId === selectedPaneId)?.messageId ?? null;
  } else if (nextMessages.some((message) => message.messageId === currentSelectedMessageId)) {
    nextSelectedId = currentSelectedMessageId;
  } else {
    nextSelectedId = nextMessages.find((message) => message.paneId === selectedPaneId)?.messageId
      ?? (snapshotSelectedMessageId !== null && nextMessages.some((message) => message.messageId === snapshotSelectedMessageId)
        ? snapshotSelectedMessageId
        : null);
  }

  return {
    nextSelectedMessageId: nextSelectedId,
    followNextPaneResponseReset: false,
  };
}
