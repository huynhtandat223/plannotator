/**
 * Hiding the Agent Response panel has to give the space back.
 *
 * The regression this guards is the one the captain kept seeing: a panel that
 * "collapses" by emptying itself while its header, its chrome and its share of
 * the column go on holding the top of the page.
 */

import { expect, test } from 'bun:test';
import {
  AGENT_RESPONSE_PANEL_BOX_CLASS,
  agentResponsePanelWrapperClass,
} from './agentResponsePanelLayout';

test('the shown panel is an ordinary in-flow block, above or beside the document', () => {
  const shown = agentResponsePanelWrapperClass(true);
  expect(shown).toBe(AGENT_RESPONSE_PANEL_BOX_CLASS);
  // Nothing takes it out of the flex flow, so it occupies real space.
  expect(shown).not.toContain('absolute');
  expect(shown).not.toContain('invisible');
  // Full-width block when the layout stacks; a fixed column when it does not.
  expect(shown).toContain('w-full');
  expect(shown).toContain('lg:w-[380px]');
});

test('the hidden panel leaves the flow entirely rather than merely emptying', () => {
  const hidden = agentResponsePanelWrapperClass(false);
  // Out of flow: the document reclaims the whole area, vertical space included.
  expect(hidden).toContain('absolute');
  expect(hidden).toContain('left-0');
  expect(hidden).toContain('top-0');
  // Unpainted, out of the tab order and the a11y tree, and non-interactive.
  expect(hidden).toContain('invisible');
  expect(hidden).toContain('pointer-events-none');
});

test('the hidden box measures the same as the shown one, so the transcript keeps working', () => {
  const hidden = agentResponsePanelWrapperClass(false);
  // Every sizing class survives verbatim. The transcript stays mounted while
  // hidden and its scroller's real clientHeight is what the live scroll anchor
  // and the `+N more` auto-fill both read — a collapsed-to-zero box would make
  // both of them page and anchor against a viewport that does not exist.
  for (const token of AGENT_RESPONSE_PANEL_BOX_CLASS.split(' ')) {
    expect(hidden.split(' ')).toContain(token);
  }
});
