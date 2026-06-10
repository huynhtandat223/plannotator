import { describe, test, expect } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown, trimUrlTail } from './InlineMarkdown';

function renderInline(text: string): string {
  return renderToStaticMarkup(React.createElement(InlineMarkdown, { text }));
}

describe('trimUrlTail', () => {
  test('trims trailing period', () => {
    expect(trimUrlTail('https://foo.com.')).toBe('https://foo.com');
  });

  test('trims trailing comma / semicolon / question mark', () => {
    expect(trimUrlTail('https://foo.com,')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com;')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com?')).toBe('https://foo.com?'.replace(/\?$/, ''));
  });

  test('keeps closing paren when it balances an opener', () => {
    expect(trimUrlTail('https://en.wikipedia.org/wiki/Function_(mathematics)')).toBe(
      'https://en.wikipedia.org/wiki/Function_(mathematics)',
    );
  });

  test('trims unbalanced closing paren', () => {
    expect(trimUrlTail('https://foo.com/path)')).toBe('https://foo.com/path');
  });

  test('keeps closing bracket when balanced', () => {
    expect(trimUrlTail('https://foo.com/[a]')).toBe('https://foo.com/[a]');
  });

  test('trims unbalanced closing bracket', () => {
    expect(trimUrlTail('https://foo.com]')).toBe('https://foo.com');
  });

  test('trims stacked punctuation', () => {
    expect(trimUrlTail('https://foo.com).')).toBe('https://foo.com');
  });

  test('leaves URL alone when no trailing punctuation', () => {
    expect(trimUrlTail('https://foo.com/path')).toBe('https://foo.com/path');
  });
});

describe('InlineMarkdown angle autolinks', () => {
  test('keeps xref contents literal', () => {
    const html = renderInline('For more information, see the <xref:path_to_api`22?hello> class.');

    expect(html).toContain('<span>&lt;xref:path_to_api`22?hello&gt;</span>');
    expect(html).not.toContain('<code');
    expect(html).not.toContain('<em');
  });

  test('keeps URL and email autolinks clickable', () => {
    const html = renderInline('Visit <https://www.example.com> or <user@example.com>.');

    expect(html).toContain('href="https://www.example.com"');
    expect(html).toContain('href="mailto:user@example.com"');
  });

  test('keeps comparison text as plain prose', () => {
    const html = renderInline('Math: x < y > z.');

    expect(html).toBe('Math: x &lt; y &gt; z.');
  });

  test('keeps other scheme autolinks literal', () => {
    const html = renderInline('Open <file://path/to/file> or <custom:value_with-dash.ext>.');

    expect(html).toContain('<span>&lt;file://path/to/file&gt;</span>');
    expect(html).toContain('<span>&lt;custom:value_with-dash.ext&gt;</span>');
  });

  test('does not consume incomplete angle autolinks', () => {
    const html = renderInline('Broken <xref:path_to_api`22?hello is plain.');

    expect(html).toBe('Broken &lt;xref:path_to_api`22?hello is plain.');
  });
});
