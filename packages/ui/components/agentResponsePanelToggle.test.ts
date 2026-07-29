/**
 * One vocabulary for the one control, so the rail, the sidebar tab bar and the
 * header cannot drift apart — and one rule for when the header copy is allowed
 * to stay above `lg`.
 */

import { expect, test } from 'bun:test';
import {
  agentResponseHeaderToggleClass,
  agentResponseToggleLabel,
} from './agentResponsePanelToggle';

test('the label is verb-first: it states what pressing it will do', () => {
  expect(agentResponseToggleLabel(true)).toBe('Hide Agent Response panel');
  expect(agentResponseToggleLabel(false)).toBe('Show Agent Response panel');
});

test('the header copy defers above lg while another home carries the toggle', () => {
  // The desktop header must not grow a second, redundant control beside the
  // rail flag; below `lg` this element is the only home and stays visible.
  expect(agentResponseHeaderToggleClass(false)).toContain('lg:hidden');
});

test('the header copy stays above lg when it is the last home standing', () => {
  // Whatever unmounted the rail and the sidebar, the panel it controls is
  // still painted — so this must not be hidden by a breakpoint.
  expect(agentResponseHeaderToggleClass(true)).not.toContain('hidden');
});
