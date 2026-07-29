import { expect, test } from 'bun:test';
import {
  SESSION_PREVIEW_MAX_CHARS,
  sessionAge,
  sessionPreview,
  sessionRowAccessibleName,
} from './sessionRowPreview';

test('strips the markdown syntax a live pane actually emits', () => {
  // Verbatim shape of a real switcher row before this helper existed.
  const raw = [
    '# 2ndmate-oracle',
    '## fm-oracle · Pane pD',
    '',
    '> [!WARNING]',
    '> **No transcript for this pane.** Two or more live panes are running.',
  ].join('\n');

  const preview = sessionPreview(raw);

  expect(preview).toBe('2ndmate-oracle fm-oracle · Pane pD No transcript for this pane. Two or more live panes are running.');
  for (const syntax of ['#', '>', '[!WARNING]', '**']) {
    expect(preview).not.toContain(syntax);
  }
});

test('reduces list, link, code and emphasis markup to the words a reader scans', () => {
  const raw = [
    '- Ran `bun test` in *watch* mode',
    '1. Opened [the review](https://example.com/pr/42)',
    '---',
    '~~Reverted~~ __done__',
    '```ts',
    'const noise = 1;',
    '```',
  ].join('\n');

  // Fence markers vanish; the code they wrap stays, in its original position.
  expect(sessionPreview(raw)).toBe('Ran bun test in watch mode Opened the review Reverted done const noise = 1;');
});

test('collapses to a single line and hard-caps the length', () => {
  const preview = sessionPreview('alpha\n\nbeta\n\ngamma');
  expect(preview).toBe('alpha beta gamma');

  const long = sessionPreview('x'.repeat(400));
  expect(long.length).toBe(SESSION_PREVIEW_MAX_CHARS + 1); // + the ellipsis
  expect(long.endsWith('…')).toBe(true);
});

test('handles empty and syntax-only text without emitting stray punctuation', () => {
  expect(sessionPreview('')).toBe('');
  expect(sessionPreview('---')).toBe('');
  expect(sessionPreview('```\n```')).toBe('');
});

test('reports a compact age and stays silent when the host sent none', () => {
  const now = Date.parse('2026-07-29T15:00:00Z');
  const at = (iso: string) => sessionAge(iso, now);

  expect(at('2026-07-29T14:59:30Z')).toBe('now');
  expect(at('2026-07-29T14:56:00Z')).toBe('4m');
  expect(at('2026-07-29T12:00:00Z')).toBe('3h');
  expect(at('2026-07-27T15:00:00Z')).toBe('2d');
  expect(at('2026-06-01T15:00:00Z')).toMatch(/Jun/);

  // A clock skew must not render as a negative age.
  expect(at('2026-07-29T15:00:30Z')).toBe('now');
  expect(sessionAge(undefined, now)).toBeNull();
  expect(sessionAge('not-a-date', now)).toBeNull();
});

// --- accessible name -------------------------------------------------------

test('composes a switcher row name with separated, labelled fields', () => {
  // The bug this replaces, measured verbatim from the live surface:
  //   "●firstmate · fm-plannotator-uiux-top10-audit1m4The Close path is…"
  // where "1m" (age) ran into "4" (unread) and read as "one m four".
  expect(
    sessionRowAccessibleName({
      identity: 'firstmate · fm-plannotator-uiux-top10-audit',
      activity: 'Thinking…',
      age: '1m',
      unread: 4,
      preview: 'The Close path is confirmed',
    }),
  ).toBe(
    'firstmate · fm-plannotator-uiux-top10-audit, Thinking…, last active 1m ago, 4 unread responses, latest: The Close path is confirmed',
  );
});

test('gives the unread count a unit and gets the singular right', () => {
  const name = sessionRowAccessibleName({ identity: 'ws · tab', unread: 1 });
  expect(name).toContain('1 unread response');
  expect(name).not.toContain('1 unread responses');
});

test('omits fields the host did not supply rather than inventing them', () => {
  // No timestamp, no activity, nothing unread, no preview.
  expect(sessionRowAccessibleName({ identity: 'ws · tab' })).toBe('ws · tab');
  expect(sessionRowAccessibleName({ identity: 'ws · tab', unread: 0, age: null, activity: null }))
    .toBe('ws · tab');
});

test('reads "now" as a phrase rather than a duration', () => {
  expect(sessionRowAccessibleName({ identity: 'ws · tab', age: 'now' })).toBe('ws · tab, active now');
  expect(sessionRowAccessibleName({ identity: 'ws · tab', age: '3h' })).toBe('ws · tab, last active 3h ago');
});
