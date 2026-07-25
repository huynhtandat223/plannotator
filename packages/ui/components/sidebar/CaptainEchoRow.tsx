/**
 * CaptainEchoRow — the captain's own sent message, echoed back into the live
 * message list from browser-local state.
 *
 * These rows are NOT server-confirmed history. The host never stores captain
 * turns (the pending instruction is destroyed on claim for at-most-once
 * delivery), so the row is labelled `local` with a tooltip saying it is visible
 * only in this browser session.
 *
 * Rendered as a non-interactive `<li>`-style div, never a button: an echo is
 * navigation context only and is never an annotation or review target.
 */

import React from "react";

/** Hard cap so a long prompt cannot blow out the sidebar. Matches the picker's preview budget. */
const PREVIEW_MAX_CHARS = 220;

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS).trimEnd() + "…"
    : normalized;
}

export const CAPTAIN_ECHO_LOCAL_TOOLTIP =
  "Your sent message, shown from this browser session only. It is not stored on the server.";

/**
 * `row`   — the original indented, accent-bordered list row (the default; keeps
 *           every existing non-live/legacy surface visually unchanged).
 * `bubble`— a right-aligned chat bubble for the two-sided live transcript. Same
 *           semantics: still a non-interactive div, never an annotation target.
 */
export type CaptainEchoVariant = "row" | "bubble";

export const CaptainEchoRow: React.FC<{
  text: string;
  timestamp?: string | null;
  variant?: CaptainEchoVariant;
}> = ({ text, timestamp, variant = "row" }) =>
  variant === "bubble" ? (
    // Right-aligned so the captain's own turns sit opposite the agent's
    // left-aligned response rows, reading as a two-sided chat. Still a plain
    // div — an echo is never a selectable annotation/review target.
    <div data-captain-echo="true" className="flex w-full justify-end">
      <div className="max-w-[85%] rounded-lg rounded-br-sm border border-primary/25 bg-primary/[0.08] px-2.5 py-1.5 text-xs text-foreground/90">
        <div className="flex items-center justify-end gap-1.5 mb-0.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            You
          </span>
          <span
            className="inline-flex rounded border border-border bg-muted/50 px-1 text-[9px] font-medium text-muted-foreground"
            title={CAPTAIN_ECHO_LOCAL_TOOLTIP}
          >
            local
          </span>
          <span className="sr-only">{CAPTAIN_ECHO_LOCAL_TOOLTIP}</span>
        </div>
        <span className="line-clamp-3 leading-snug whitespace-pre-wrap">{previewText(text)}</span>
        {timestamp && (
          <span className="block text-right text-[10px] text-muted-foreground mt-0.5">Sent {timestamp}</span>
        )}
      </div>
    </div>
  ) : (
    <div
      data-captain-echo="true"
      // Indented and accent-bordered so a captain turn never reads like an
      // assistant response row, which is a selectable button.
      className="w-full pl-6 pr-2 py-1.5 rounded text-xs border border-dashed border-primary/25 bg-primary/[0.04] text-foreground/90"
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          You
        </span>
        <span
          className="inline-flex rounded border border-border bg-muted/50 px-1 text-[9px] font-medium text-muted-foreground"
          title={CAPTAIN_ECHO_LOCAL_TOOLTIP}
        >
          local
        </span>
        <span className="sr-only">{CAPTAIN_ECHO_LOCAL_TOOLTIP}</span>
      </div>
      <span className="line-clamp-3 leading-snug whitespace-pre-wrap">{previewText(text)}</span>
      {timestamp && (
        <span className="block text-[10px] text-muted-foreground mt-0.5">Sent {timestamp}</span>
      )}
    </div>
  );
