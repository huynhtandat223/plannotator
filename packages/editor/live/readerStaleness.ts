/**
 * "The response you are reading is not the newest one."
 *
 * The live reader pins the selected response on purpose — a captain mid-way
 * through annotating a turn must not have the document swapped out from under
 * them, and the captain confirmed that policy. The failure mode is the other
 * half of it: the pin was silent. Measured on the live surface, the reader sat
 * on an 08:20 turn while the panel counted 8, then 13, then 15 newer replies,
 * and the document area — the only place the captain was actually looking —
 * said nothing at all. The panel's own "N new replies" affordance is inside a
 * block that can be hidden from the rail, and below `lg` it was not rendered at
 * all, so on a phone the staleness had no signal anywhere.
 *
 * So staleness is derived here, from the same newest-first timeline the panel
 * renders, and surfaced in the reader. Pure and separately tested because the
 * off-by-one in "how far behind am I" is exactly the kind of thing that reads
 * fine and counts wrong.
 */

/** The minimum a message needs for staleness to be computable. */
export type StalenessMessage = {
  messageId: string;
};

export type ReaderStaleness = {
  /** The newest response in the active pane, or null when there is none. */
  latestMessageId: string | null;
  /**
   * How many responses are newer than the selected one. 0 when the reader is
   * on the newest response, or when the selection is not in this pane at all —
   * an unknown selection is never reported as "0 behind" AND never guessed at.
   */
  behindBy: number;
  /** 1-based position of the selected response, oldest = 1. 0 when unknown. */
  position: number;
  /** Total responses in the active pane. */
  total: number;
  /** Whether to show the in-reader banner. */
  isStale: boolean;
};

const EMPTY: ReaderStaleness = {
  latestMessageId: null,
  behindBy: 0,
  position: 0,
  total: 0,
  isStale: false,
};

/**
 * @param timeline the active pane's responses, NEWEST FIRST — the order
 *   `LiveSessionTimeline` already renders and the order the wire delivers, so
 *   no caller has to reverse anything and get it wrong.
 */
export function readerStaleness(
  timeline: readonly StalenessMessage[] | null | undefined,
  selectedMessageId: string | null | undefined,
): ReaderStaleness {
  if (!timeline || timeline.length === 0) return EMPTY;
  const total = timeline.length;
  const latestMessageId = timeline[0]!.messageId;
  if (!selectedMessageId) {
    return { latestMessageId, behindBy: 0, position: 0, total, isStale: false };
  }
  const index = timeline.findIndex((message) => message.messageId === selectedMessageId);
  if (index < 0) {
    // The selection belongs to another pane (or has aged out of the retained
    // window). Claiming a distance would be a fabrication, so claim none.
    return { latestMessageId, behindBy: 0, position: 0, total, isStale: false };
  }
  return {
    latestMessageId,
    behindBy: index,
    // Newest-first: index 0 is the newest, so it is the LAST position.
    position: total - index,
    total,
    isStale: index > 0,
  };
}

/**
 * Banner copy. Says how far behind the reader is and what the button will do,
 * rather than a bare count the captain has to interpret.
 */
export function readerStalenessLabel(state: ReaderStaleness): string {
  if (!state.isStale) return "";
  const noun = state.behindBy === 1 ? "response" : "responses";
  return `${state.behindBy} newer ${noun} in this pane · you're reading ${state.position} of ${state.total}`;
}
