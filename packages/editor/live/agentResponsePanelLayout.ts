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

/**
 * In-flow: a full-width block above the document, a wide column beside it.
 *
 * The width is a clamp rather than the old fixed `380px` because the panel is
 * now opened deliberately from the rail instead of standing there by default:
 * when a captain asks for it they are reading a transcript, and 380px wrapped
 * every response into a narrow ribbon beside acres of empty grid. The clamp
 * keeps a 1280px laptop close to the old feel and lets a 1600px+ display give
 * the transcript real width, without ever taking so much that the reader beside
 * it collapses.
 *
 * The height follows the same reasoning — it uses the column it is given rather
 * than stopping at 62dvh with empty space beneath it.
 */
export const AGENT_RESPONSE_PANEL_BOX_CLASS =
  "mb-4 w-full lg:h-[min(84dvh,60rem)] lg:min-h-[26rem] lg:w-[clamp(24rem,32vw,34rem)] lg:shrink-0 lg:max-w-none";

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
 * The toggle has three homes because the left rail comes and goes: the
 * collapsed rail (`SidebarTabs`), the open sidebar's tab bar
 * (`SidebarContainer`), and the header cluster.
 *
 * The rail is now the toggle's home at EVERY width during live review — the
 * captain asked for one place to reach Agent Response on desktop and on a
 * phone, rather than a rail control that silently became a header control below
 * `lg`. So the rail renders unbreakpointed while live review is on, and the
 * header copy is demoted to a pure fallback for the states that unmount the
 * rail (an open sidebar, an open agent terminal). Every condition that unmounts
 * the rail still has to be checked against whether the live panel is on screen
 * — otherwise the panel is stranded with no control at all, which is the exact
 * shape the captain reported.
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
   * The header copy is now a pure fallback for the states that unmount the
   * rail, and when it renders it renders at EVERY width.
   *
   * It used to be `lg:hidden` because the rail was itself `hidden lg:flex`, so
   * the two split the width range between them. With the rail unbreakpointed
   * the split is gone: either the rail is mounted and owns the toggle
   * everywhere, or it is not and the header owns it everywhere. Keeping the
   * fallback defined for ALL states — rather than per known layout mode — is
   * what stops a later mode from silently stranding the panel again.
   */
  headerAtLargeWidths: boolean;
} {
  const rail = state.liveMessageReview && sidebarRailMounted(state);
  const sidebarTabBar =
    state.liveMessageReview && !state.planReview && !state.goalSetupMode && state.sidebarOpen;
  // Not `!rail && !sidebarTabBar`: below `lg` the sidebar's tab bar is hidden,
  // so a state whose only non-rail home was the tab bar would have no reachable
  // toggle on a phone.
  const header = state.liveMessageReview && !rail;
  return {
    rail,
    sidebarTabBar,
    header,
    headerAtLargeWidths: header,
  };
}

/** Whether a captain at this width can actually reach the toggle. */
export function agentResponseToggleReachable(
  state: AgentResponseLayoutState,
  viewport: AgentResponseViewport,
): boolean {
  const homes = agentResponseToggleHomes(state);
  // The rail counts at both viewports now — that is the whole point of moving
  // Agent Response into it on desktop and mobile alike.
  return viewport === "below-lg"
    ? homes.rail || homes.header
    : homes.rail || homes.sidebarTabBar || homes.header;
}
