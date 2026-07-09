/**
 * Re-export surface test: hosts import wikiLinks (and its types) from
 * @plannotator/ui's MarkdownEditor module — never from @plannotator/atomic-editor
 * directly (the engine is outside the consumer import allowlist).
 *
 * Runs without DOM: it pins identity and the type surface, not editor behavior
 * (the extensions seam itself is covered by MarkdownEditor.extensions.test.tsx).
 */
import { describe, test, expect } from 'bun:test';
import { wikiLinks as engineWikiLinks } from '@plannotator/atomic-editor';
import {
  wikiLinks,
  type WikiLinksConfig,
  type WikiLinkSuggestion,
  type WikiLinkResolvedTarget,
  type WikiLinkStatus,
} from './MarkdownEditor';

describe('MarkdownEditor module: wikiLinks re-export', () => {
  test('wikiLinks is the engine implementation, re-exported unchanged', () => {
    expect(typeof wikiLinks).toBe('function');
    expect(wikiLinks).toBe(engineWikiLinks);
  });

  test('the config types round-trip through the ui surface', () => {
    // Compile-time assertions: these fail typecheck (not just this test) if
    // the re-exported types drift from the engine's contracts.
    const suggestion: WikiLinkSuggestion = { target: 'doc_01XYZ', label: 'Roadmap' };
    const resolved: WikiLinkResolvedTarget = {
      target: 'doc_01XYZ',
      label: 'Roadmap',
      status: 'resolved',
    };
    const status: WikiLinkStatus = 'missing';
    const config: WikiLinksConfig = {
      suggest: async () => [suggestion],
      resolve: async () => resolved,
      onOpen: () => {},
      openOnClick: true,
      maxSuggestions: 10,
    };
    const extension = wikiLinks(config);
    expect(extension).toBeDefined();
    expect(status).toBe('missing');
  });
});
