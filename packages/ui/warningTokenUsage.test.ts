/**
 * `--warning-foreground` is the ON-SOLID-`--warning` pairing — a near-black in
 * every theme, dark and light alike. Used as a text colour over a *tinted*
 * warning surface (`bg-warning/10`) or over the page itself, it renders
 * near-black on near-black on any dark theme.
 *
 * That is not hypothetical: measured on the running live-pane surface it came
 * out at 1.05:1 against `bg-warning/10` and 1.09:1 against the page background,
 * against a WCAG AA requirement of 4.5:1. Every warning-severity message on that
 * screen was invisible — the "this pane is limited" notice that is supposed to
 * be the thing making a limited pane legible, the agent-stopped banner, the
 * context-handoff warning, and the context percentage exactly when it crosses
 * into its warn state.
 *
 * `--warning-strong` is the token for warning text on a tinted or plain
 * surface. This test is the guard that keeps the two from being confused again,
 * because the failure is invisible in the one theme most people develop in
 * (light) and silent in code review.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCANNED = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'legacy', 'build']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(tsx|ts)$/.test(entry)) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    out.push(full);
  }
  return out;
}

const FILES = SCANNED.flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)));

/**
 * A class string may only use `text-warning-foreground` when the SAME string
 * also sets a solid `bg-warning` — not `bg-warning/10` and friends, whose alpha
 * lets the dark page through and destroys the contrast the token assumes.
 */
function offendingLines(file: string): string[] {
  const bad: string[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.includes('text-warning-foreground')) return;
    const hasSolidWarningBg = /\bbg-warning\b(?!\/)/.test(line);
    if (!hasSolidWarningBg) bad.push(`${file.slice(REPO_ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
  });
  return bad;
}

describe('warning token usage', () => {
  test('scans a real, non-empty set of source files', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(FILES.length).toBeGreaterThan(200);
  });

  test('never uses text-warning-foreground except on a solid bg-warning', () => {
    const offenders = FILES.flatMap(offendingLines);
    expect(offenders).toEqual([]);
  });

  test('the tint-surface warning token is defined for both themes', () => {
    const theme = readFileSync(join(REPO_ROOT, 'packages/ui/theme.css'), 'utf8');
    // Once in the base layer (dark is the default) and once under `.light`,
    // because warning text has to go lighter on a dark surface and darker on a
    // light one — a single value cannot serve both.
    const declarations = theme.match(/--warning-strong:/g) ?? [];
    expect(declarations.length).toBe(2);

    const lightBlock = theme.slice(theme.indexOf('.light {'));
    expect(lightBlock).toContain('--warning-strong:');

    // Derived from each theme's own --warning rather than hardcoded, so the 20+
    // per-theme override files keep working without being edited.
    expect(theme).toContain('color-mix(in oklab, var(--warning) 88%, white)');
    expect(theme).toContain('color-mix(in oklab, var(--warning) 72%, black)');

    // And exposed to Tailwind, or `text-warning-strong` silently does nothing.
    expect(theme).toContain('--color-warning-strong: var(--warning-strong);');
  });

  test('the live surfaces that regressed now use the tint-surface token', () => {
    const check = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
    // The notice CLAUDE.md names as the invariant keeping a limited pane
    // "visibly and specifically limited — never rich-looking and empty".
    expect(check('packages/editor/LivePaneLimitationsNotice.tsx')).toContain('text-warning-strong');
    // The agent-stopped banner and the context-handoff warning copy.
    expect(check('packages/editor/App.tsx')).toContain('text-warning-strong');
    expect(check('packages/editor/LivePaneChipsRow.tsx')).toContain('text-warning-strong');
  });
});
