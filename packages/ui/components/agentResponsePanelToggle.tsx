/**
 * Shared vocabulary for the one control that shows/hides the whole live
 * Agent Response panel.
 *
 * The control appears wherever the app's left-edge controls appear for the
 * current viewport — the collapsed rail (`SidebarTabs`), the open sidebar's
 * tab bar (`SidebarContainer`), and the narrow-viewport header cluster — and
 * every instance drives the same host state. Label and glyph live here so the
 * three never drift apart and a captain reads the same words wherever they
 * find it.
 */

import React from "react";

/** Verb-first, so the label states what activating it will DO. */
export function agentResponseToggleLabel(visible: boolean): string {
  return visible ? "Hide Agent Response panel" : "Show Agent Response panel";
}

/** Short form for surfaces that show text beside the glyph. */
export const AGENT_RESPONSE_TOGGLE_SHORT_LABEL = "Response";

/**
 * A panel outline whose leading region is filled while the panel is on screen
 * and empty while it is away — so the flag reads as a state, not just an icon.
 */
export const AgentResponsePanelIcon: React.FC<{ visible: boolean; className?: string }> = ({
  visible,
  className,
}) => (
  <svg
    className={className}
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h16v14H4z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 5v14" />
    {visible && <path d="M5 6h4v12H5z" fill="currentColor" stroke="none" />}
  </svg>
);
