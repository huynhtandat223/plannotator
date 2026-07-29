/**
 * The header's popovers have to paint ABOVE the document.
 *
 * They stopped doing so, and the failure was invisible in code review because
 * every ingredient looked correct in isolation:
 *
 *  - `<header className="… backdrop-blur-xl z-[50]">` — looks like it wins.
 *  - `App.tsx` wraps it in a plain `<div inert={…}>` to carry the live-review
 *    lock. That wrapper is `display: block`, so the header is neither
 *    positioned nor a flex item — and `z-index` applies to neither. The z-50 is
 *    silently inert.
 *  - `backdrop-filter` still makes the header a stacking context, so its
 *    `z-70` menu is clamped inside a box that now sits at DOM order.
 *  - The document area is `relative z-0` — a real stacking context, later in
 *    DOM order, which therefore paints on top.
 *
 * Result, measured in a real browser: the Options menu rendered 256x338 fully
 * inside the viewport with only its top 86px — the Theme row — clickable.
 * Settings, Export, Download Annotations, Print / Save as PDF, Release notes
 * and Copy update command all returned someone else from
 * `document.elementFromPoint` at their own centre. Adding `position: relative`
 * to the header made every one of them hit-testable again.
 *
 * happy-dom has no layout or paint, so the browser check is the acceptance
 * criterion; this is the cheap invariant that stops the regression returning:
 * a z-index on this header is meaningless unless it is also positioned.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dir, 'AppHeader.tsx'), 'utf8');

function headerClassAttribute(): string {
  const match = SOURCE.match(/<header data-app-header="true" className="([^"]+)"/);
  if (!match) throw new Error('AppHeader no longer renders a <header data-app-header="true"> with a static className');
  return match[1]!;
}

test('the app header declares a z-index', () => {
  // If this ever stops being true the test below is vacuous rather than wrong,
  // so assert the premise explicitly.
  expect(headerClassAttribute()).toMatch(/\bz-\[?\d/);
});

test('the app header is positioned, so its z-index actually applies', () => {
  const className = headerClassAttribute();
  // `relative`, `sticky`, `fixed` or `absolute` all establish the positioning
  // that `z-index` needs. `static` (the default) does not.
  expect(className).toMatch(/\b(relative|sticky|fixed|absolute)\b/);
});

test('the header still forms a stacking context, which is why positioning matters', () => {
  // `backdrop-blur-*` is the ingredient that clamps the Options menu's own
  // z-70 inside the header's box. Losing it would change the analysis above,
  // so this records the assumption rather than asserting a requirement.
  expect(headerClassAttribute()).toContain('backdrop-blur');
});

test('the document area that competes with the header is still a z-0 stacking context', () => {
  // The other half of the pair. If this stops being `relative z-0`, the header
  // fix is no longer load-bearing and this file should be revisited.
  const app = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');
  expect(app).toContain('flex-1 flex overflow-hidden relative z-0');
});
