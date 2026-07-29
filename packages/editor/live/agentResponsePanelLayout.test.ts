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
  // Full-width block when the layout stacks; a wide column when it does not.
  expect(shown).toContain('w-full');
  // Opened deliberately from the rail, the panel is substantially wider than
  // the old fixed 380px ribbon, and clamped so it can never starve the reader.
  expect(shown).toContain('lg:w-[clamp(24rem,32vw,34rem)]');
  expect(shown).not.toContain('lg:w-[380px]');
  // And it uses the height it is given instead of stopping at 62dvh.
  expect(shown).toContain('lg:h-[min(84dvh,60rem)]');
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
    // The rail owns it at every width now, so the header grows no copy at all —
    // not a hidden one. One control, one place, desktop and phone alike.
    header: false,
    headerAtLargeWidths: false,
  });
  // Opening the sidebar unmounts the rail. The tab bar picks it up above `lg`,
  // but the tab bar is itself `hidden lg:flex`, so the header copy has to
  // render too or a phone with the sidebar open could not reach the toggle.
  expect(agentResponseToggleHomes({ ...desktopLive, sidebarOpen: true })).toEqual({
    rail: false,
    sidebarTabBar: true,
    header: true,
    headerAtLargeWidths: true,
  });
});

test('the rail carries the toggle on a phone, not just above lg', () => {
  const phoneLive: AgentResponseLayoutState = {
    liveMessageReview: true,
    planReview: false,
    goalSetupMode: false,
    sidebarOpen: false,
    agentTerminalOpen: false,
    wideMode: false,
  };
  // The captain's ask: Agent Response is reachable from the same rail slot on
  // desktop and mobile. Below `lg` that used to be the header's job alone.
  expect(agentResponseToggleHomes(phoneLive).rail).toBe(true);
  expect(agentResponseToggleReachable(phoneLive, 'below-lg')).toBe(true);
  expect(agentResponseToggleReachable(phoneLive, 'lg-and-up')).toBe(true);
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

test('the rail and the header copy are never both mounted', () => {
  // Two visible toggles driving one state is the confusion the rail move was
  // meant to end, so this is an invariant rather than an incidental property.
  for (const state of everyLayoutState()) {
    const homes = agentResponseToggleHomes(state);
    expect(homes.rail && homes.header).toBe(false);
  }
});
