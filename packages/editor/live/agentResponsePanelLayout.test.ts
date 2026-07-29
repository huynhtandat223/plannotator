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
  agentResponsePanelOnScreen,
  agentResponsePanelWrapperClass,
  agentResponseToggleHomes,
  agentResponseToggleReachable,
  sidebarRailMounted,
  type AgentResponseLayoutState,
  type AgentResponseViewport,
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

/**
 * The regression that actually shipped: a live context where the panel is on
 * screen and NO toggle renders.
 *
 * Every previous test asserted the control given a state that mounts it, so a
 * layout mode that unmounts every home at once passed all of them while the
 * browser showed a 380x558 panel with nothing to close it. This sweeps the
 * whole state space instead of the states someone thought to write down.
 */

const LAYOUT_FLAGS = [
  'liveMessageReview',
  'planReview',
  'goalSetupMode',
  'sidebarOpen',
  'agentTerminalOpen',
  'wideMode',
] as const;

const VIEWPORTS: AgentResponseViewport[] = ['below-lg', 'lg-and-up'];

function everyLayoutState(): AgentResponseLayoutState[] {
  const states: AgentResponseLayoutState[] = [];
  for (let mask = 0; mask < 1 << LAYOUT_FLAGS.length; mask++) {
    const state = {} as Record<(typeof LAYOUT_FLAGS)[number], boolean>;
    LAYOUT_FLAGS.forEach((flag, i) => {
      state[flag] = (mask & (1 << i)) !== 0;
    });
    states.push(state as AgentResponseLayoutState);
  }
  return states;
}

test('the panel is never on screen without a reachable toggle, at any width', () => {
  const stranded: string[] = [];
  for (const state of everyLayoutState()) {
    if (!agentResponsePanelOnScreen(state)) continue;
    for (const viewport of VIEWPORTS) {
      if (agentResponseToggleReachable(state, viewport)) continue;
      const on = LAYOUT_FLAGS.filter(flag => state[flag]).join(' + ');
      stranded.push(`${viewport}: ${on}`);
    }
  }
  expect(stranded).toEqual([]);
});

test('wide and focus mode keep the rail during live review — it is the only home above lg', () => {
  // Exactly the browser-verified case: 1440px, live review, sidebar closed,
  // Wide pressed. Before the fix the rail unmounted, the sidebar was closed by
  // wide mode itself, and the header copy is `lg:hidden` — so the panel stayed
  // painted with no control anywhere.
  const wideLive: AgentResponseLayoutState = {
    liveMessageReview: true,
    planReview: false,
    goalSetupMode: false,
    sidebarOpen: false,
    agentTerminalOpen: false,
    wideMode: true,
  };
  expect(agentResponsePanelOnScreen(wideLive)).toBe(true);
  expect(sidebarRailMounted(wideLive)).toBe(true);
  expect(agentResponseToggleHomes(wideLive).rail).toBe(true);
  expect(agentResponseToggleReachable(wideLive, 'lg-and-up')).toBe(true);
});

test('wide mode still puts the rail away outside live review', () => {
  // The rail survives wide mode only because the live panel does. With nothing
  // to strand, wide mode keeps its width back.
  expect(
    sidebarRailMounted({
      liveMessageReview: false,
      planReview: false,
      goalSetupMode: false,
      sidebarOpen: false,
      agentTerminalOpen: false,
      wideMode: true,
    }),
  ).toBe(false);
});

test('the ordinary live desktop keeps the rail as its home, unchanged', () => {
  // The captain's reported layout: 1440px, live review, sidebar closed.
  const desktopLive: AgentResponseLayoutState = {
    liveMessageReview: true,
    planReview: false,
    goalSetupMode: false,
    sidebarOpen: false,
    agentTerminalOpen: false,
    wideMode: false,
  };
  expect(agentResponseToggleHomes(desktopLive)).toEqual({
    rail: true,
    sidebarTabBar: false,
    header: true,
    // The rail owns it here, so the header copy stays `lg:hidden` — the desktop
    // header does not grow a second visible control.
    headerAtLargeWidths: false,
  });
  // Opening the sidebar unmounts the rail and hands the toggle to the tab bar.
  expect(agentResponseToggleHomes({ ...desktopLive, sidebarOpen: true })).toEqual({
    rail: false,
    sidebarTabBar: true,
    header: true,
    headerAtLargeWidths: false,
  });
});

test('the header stops deferring only when no other home is mounted', () => {
  // Wide mode during live review is covered by the rail, so the header copy
  // must stay out of the way there — one visible control, not two.
  expect(
    agentResponseToggleHomes({
      liveMessageReview: true,
      planReview: false,
      goalSetupMode: false,
      sidebarOpen: false,
      agentTerminalOpen: false,
      wideMode: true,
    }).headerAtLargeWidths,
  ).toBe(false);
  // A layout that unmounts the rail without opening the sidebar hands the
  // control to the header rather than losing it.
  expect(
    agentResponseToggleHomes({
      liveMessageReview: true,
      planReview: true,
      goalSetupMode: false,
      sidebarOpen: false,
      agentTerminalOpen: false,
      wideMode: false,
    }).headerAtLargeWidths,
  ).toBe(true);
});
