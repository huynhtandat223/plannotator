/**
 * The staleness banner must clear the reader's Wide/Focus overlay strip.
 *
 * PR #51 added the banner directly above the reader row in normal flow, and
 * missed that the row already reserves the strip above itself for its
 * Wide/Focus tools (`absolute -top-5`). Shipped, deployed and measured in real
 * Chrome against the live service:
 *
 *   desktop 1600x1000 — banner [94,119,1432,42], Wide [1146,153,28,17]  -> 8px
 *   mobile   390x844  — banner [38,139,344,82],  Wide [302,213,28,17]   -> 8px
 *
 * The same 8px at both widths, because it is simply `20px overlay offset` minus
 * `12px banner margin` — a constant, viewport-independent difference. That is
 * what makes it a unit-testable arithmetic invariant rather than something only
 * a screenshot could catch, and happy-dom has no layout engine to catch it any
 * other way.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  READER_BANNER_CLEARANCE_CLASS,
  READER_BANNER_CLEARANCE_PX,
  READER_TOOLS_OVERLAY_OFFSET_CLASS,
  READER_TOOLS_OVERLAY_OFFSET_PX,
} from './ReaderStalenessBanner';

const BANNER_SOURCE = readFileSync(join(import.meta.dir, 'ReaderStalenessBanner.tsx'), 'utf8');
const APP_SOURCE = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8');

/** Tailwind spacing: `n` = n * 0.25rem = n * 4px at the default root size. */
function tailwindSpacingPx(token: string): number {
  const match = token.match(/-?(?:top|mb)-(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error(`not a spacing utility: ${token}`);
  return Number(match[1]) * 4;
}

describe('reader staleness banner clearance', () => {
  test('the declared pixel values match the Tailwind classes they document', () => {
    // Guards the guard: constants that drift from their own class strings would
    // make the inequality below assert something that is not on screen.
    expect(tailwindSpacingPx(READER_TOOLS_OVERLAY_OFFSET_CLASS)).toBe(READER_TOOLS_OVERLAY_OFFSET_PX);
    expect(tailwindSpacingPx(READER_BANNER_CLEARANCE_CLASS)).toBe(READER_BANNER_CLEARANCE_PX);
  });

  test('the banner clears the overlay strip instead of being painted over', () => {
    // The regression, stated as arithmetic: 12 <= 20 overlapped by 8px.
    expect(READER_BANNER_CLEARANCE_PX).toBeGreaterThan(READER_TOOLS_OVERLAY_OFFSET_PX);
  });

  test('the banner actually renders the clearance class', () => {
    // A constant nothing uses would pass the inequality and still overlap.
    expect(BANNER_SOURCE).toContain('${READER_BANNER_CLEARANCE_CLASS}');
    // And no stale hardcoded margin left behind on that element.
    expect(BANNER_SOURCE).not.toMatch(/data-reader-staleness-banner[\s\S]{0,400}className="mb-/);
  });

  test('the reader tools overlay reads its offset from the same constant', () => {
    // The two are only safe together. If App.tsx goes back to hardcoding its
    // own offset, this pair can drift apart again silently.
    expect(APP_SOURCE).toContain('READER_TOOLS_OVERLAY_OFFSET_CLASS');
    expect(APP_SOURCE).not.toContain('absolute -top-5 left-0 right-0 mx-auto');
  });
});
