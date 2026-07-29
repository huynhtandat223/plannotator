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
