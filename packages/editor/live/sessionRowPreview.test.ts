import { expect, test } from 'bun:test';
import { SESSION_PREVIEW_MAX_CHARS, sessionAge, sessionPreview } from './sessionRowPreview';

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
