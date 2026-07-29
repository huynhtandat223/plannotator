/**
 * Geometry contract for showing/hiding the whole live Agent Response panel.
 *
 * Hiding it has to give the document back the ENTIRE area the panel occupied —
 * the header, the session row, the history and the gap around them — not just
 * blank the contents. So the wrapper leaves the flex flow (`absolute`) and is
 * removed from sight, tab order and the accessibility tree (`invisible`, plus
 * `aria-hidden`/`inert` at the call site).
 *
 * It is hidden rather than unmounted on purpose. The panel owns real reader
 * state that only exists in the DOM — the transcript's scroll offset, the rows
 * paged in with `+N more`, and the live scroll anchor that holds a reader still
 * as frames arrive. Unmounting would silently discard all three, so bringing
 * the panel back would drop the captain somewhere other than where they left.
 * Keeping the same box laid out (out of flow, just not painted) means the
 * anchor keeps working while the panel is away and re-showing is exact.
 *
 * The visible classes are shared verbatim between the two states so the hidden
 * box measures identically to the visible one: the transcript's scroller keeps
 * its real `clientHeight`, which is what the anchor and the auto-fill paging
 * both read.
 */

/** In-flow: a full-width block above the document, a fixed column beside it. */
export const AGENT_RESPONSE_PANEL_BOX_CLASS =
  "mb-4 w-full lg:h-[min(62dvh,42rem)] lg:min-h-[26rem] lg:w-[380px] lg:shrink-0 lg:max-w-none";

/** Out of flow and unpainted, but still laid out at the same size. */
export const AGENT_RESPONSE_PANEL_HIDDEN_CLASS =
  "absolute left-0 top-0 invisible pointer-events-none";

export function agentResponsePanelWrapperClass(visible: boolean): string {
  return visible
    ? AGENT_RESPONSE_PANEL_BOX_CLASS
    : `${AGENT_RESPONSE_PANEL_BOX_CLASS} ${AGENT_RESPONSE_PANEL_HIDDEN_CLASS}`;
}

/**
 * Where the toggle lives, and — the part that actually bites — where it does
 * not.
 *
 * The toggle has three homes because the left rail has breakpoints and comes
 * and goes: the collapsed rail (`SidebarTabs`), the open sidebar's tab bar
 * (`SidebarContainer`), and the header cluster. The first two are `hidden
 * lg:flex`; the header one is `lg:hidden`. So at >= lg the rail and the tab bar
 * are the ONLY homes, and every condition that unmounts the rail has to be
 * checked against whether the live panel is still on screen — otherwise the
 * panel is stranded with no control at all, which is the exact shape the
 * captain reported.
 *
 * Wide/focus mode was such a condition. It drops the rail (and closes the
 * sidebar) to give the document the width, but it does NOT unmount the live
 * Agent Response panel — measured in the browser at 1440px: panel 380x558 on
 * screen, zero toggles with a non-zero box. So the rail now survives wide mode
 * while live review is on, carrying only this one flag; wide mode's own promise
 * to put the panels away is untouched because the other flags stay suppressed.
 *
 * These are pure so the invariant below can be asserted over every combination
 * of layout state, rather than only over the handful a mounted test happens to
 * exercise.
 */
export type AgentResponseLayoutState = {
  /** Live message review — the only mode that renders the panel at all. */
  liveMessageReview: boolean;
  planReview: boolean;
  goalSetupMode: boolean;
  sidebarOpen: boolean;
  agentTerminalOpen: boolean;
  /** `wideModeType !== null` — the Wide and Focus reading modes. */
  wideMode: boolean;
};

/** `lg` and up gets the rail / sidebar tab bar; below it gets the header. */
export type AgentResponseViewport = "below-lg" | "lg-and-up";

/**
 * Whether the collapsed left rail is mounted at all. Drives both the rail and
 * the document's matching 30px left gutter, so the two cannot drift and the
 * rail can never overlap the text it sits beside.
 */
export function sidebarRailMounted(state: AgentResponseLayoutState): boolean {
  return (
    !state.planReview &&
    !state.goalSetupMode &&
    !state.sidebarOpen &&
    !state.agentTerminalOpen &&
    (!state.wideMode || state.liveMessageReview)
  );
}

/** Whether the panel itself can be on screen — hidden-by-the-toggle aside. */
export function agentResponsePanelOnScreen(state: AgentResponseLayoutState): boolean {
  return state.liveMessageReview && !state.goalSetupMode;
}

/** Which of the three homes render for this layout state. */
export function agentResponseToggleHomes(state: AgentResponseLayoutState): {
  rail: boolean;
  sidebarTabBar: boolean;
  header: boolean;
  /**
   * The header copy is `lg:hidden`, because above `lg` the rail or the tab bar
   * owns the control. It drops that gate only when neither of them is mounted.
   *
   * This is a backstop, not the fix: the rail surviving wide/focus mode is what
   * covers the case the captain hit. It exists because "which surface owns the
   * un-hide at this width" was answered once, per known layout mode, and a
   * later mode that unmounted every home silently invalidated the answer. A
   * fallback that is defined for ALL states cannot be invalidated that way.
   */
  headerAtLargeWidths: boolean;
} {
  const rail = state.liveMessageReview && sidebarRailMounted(state);
  const sidebarTabBar =
    state.liveMessageReview && !state.planReview && !state.goalSetupMode && state.sidebarOpen;
  return {
    rail,
    sidebarTabBar,
    header: state.liveMessageReview,
    headerAtLargeWidths: state.liveMessageReview && !rail && !sidebarTabBar,
  };
}

/** Whether a captain at this width can actually reach the toggle. */
export function agentResponseToggleReachable(
  state: AgentResponseLayoutState,
  viewport: AgentResponseViewport,
): boolean {
  const homes = agentResponseToggleHomes(state);
  return viewport === "below-lg"
    ? homes.header
    : homes.rail || homes.sidebarTabBar || homes.headerAtLargeWidths;
}
