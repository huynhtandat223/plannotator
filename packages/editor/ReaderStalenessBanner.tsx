/**
 * The in-reader "you are not on the newest response" banner.
 *
 * Lives in the document column rather than the Agent Response panel on purpose.
 * The panel already had a "N new replies" control, and it was not enough: the
 * panel can be hidden entirely from the left rail, and below `lg` its jump
 * affordance was not rendered at all. The captain's eyes are on the reader, so
 * the reader is where the staleness has to be stated.
 *
 * It only ever offers the jump — it never performs one. Auto-following the
 * newest turn was considered and rejected: it would swap the document out from
 * under a captain mid-annotation.
 */

import React from 'react';
import type { ReaderStaleness } from './live/readerStaleness';
import { readerStalenessLabel } from './live/readerStaleness';

export const ReaderStalenessBanner: React.FC<{
  state: ReaderStaleness;
  onJumpToLatest: () => void;
}> = ({ state, onJumpToLatest }) => {
  if (!state.isStale || !state.latestMessageId) return null;
  return (
    <div
      data-reader-staleness-banner="true"
      // `status`, not `alert`: newer responses arriving is ordinary progress,
      // and an assertive interruption on every turn would be hostile.
      role="status"
      aria-live="polite"
      className="mb-3 w-full flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-primary/35 bg-primary/10 px-3 py-2"
    >
      <span className="min-w-0 text-xs font-medium text-primary">
        <span aria-hidden="true" className="mr-1.5">
          ↑
        </span>
        {readerStalenessLabel(state)}
      </span>
      <button
        type="button"
        onClick={onJumpToLatest}
        // Its own words, not "Jump to latest" again: three near-identical
        // primary-tinted buttons reading "N new replies · Jump to new replies",
        // "Jump to latest" and "Back to latest" were stacked in the panel, and
        // nobody could tell which did what. This one states its effect.
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Read newest
      </button>
    </div>
  );
};
