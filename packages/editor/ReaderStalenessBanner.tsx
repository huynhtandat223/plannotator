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

/**
 * The reader row parks its Wide/Focus tools in an overlay pinned ABOVE its own
 * top edge, so the strip immediately above the row is already spoken for.
 *
 * Anything placed above the row in normal flow — this banner — has to clear
 * that strip or the two paint on top of each other. They did: measured on the
 * deployed service, the banner's bottom edge sat 12px above the row while the
 * tools reach 20px above it, so `Wide` and `Focus` overlapped the banner's
 * bottom-right corner by 8px at 1600x1000 AND at 390x844 — it is the constant
 * difference between the two offsets, so every viewport got the same 8px.
 *
 * These live together, and the test asserts the inequality between them, so the
 * coupling cannot silently drift the way it did when the banner was added.
 */
export const READER_TOOLS_OVERLAY_OFFSET_CLASS = '-top-5';
/** Pixel value of {@link READER_TOOLS_OVERLAY_OFFSET_CLASS} (Tailwind `5` = 1.25rem). */
export const READER_TOOLS_OVERLAY_OFFSET_PX = 20;
/** Bottom margin that clears it, with room to spare rather than exactly zero. */
export const READER_BANNER_CLEARANCE_CLASS = 'mb-6';
/** Pixel value of {@link READER_BANNER_CLEARANCE_CLASS} (Tailwind `6` = 1.5rem). */
export const READER_BANNER_CLEARANCE_PX = 24;

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
      className={`${READER_BANNER_CLEARANCE_CLASS} w-full flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-primary/35 bg-primary/10 px-3 py-2`}
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
