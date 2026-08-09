/**
 * Full-screen, read-only **Watch live** terminal overlay for ONE Herdr pane.
 *
 * Mobile portrait is the primary layout: the captain reaches this over a
 * Tailscale URL on a phone, so the terminal gets the whole dynamic viewport and
 * the chrome is exactly two things — which pane this is, and Close.
 *
 * What is deliberately absent is as much of the design as what is present.
 * There is no input, paste, Enter, resize, focus, zoom, font, settings, copy,
 * download, or export affordance anywhere in this component, and no element
 * that can receive terminal keystrokes. The only interactive element is Close.
 * That is what makes this an observation surface rather than a remote terminal.
 *
 * The three display states are a truthfulness contract, not decoration:
 * a frame replaces the previous frame outright; `Reconnecting…` REMOVES the
 * screen (an old terminal presented as live is worse than none); and a pane
 * Herdr no longer reports is terminal — `Session ended`, Close, nothing else.
 */

import React from "react";

import { parseAnsiScreen, type AnsiColor, type AnsiLine } from "@plannotator/core/ansi-screen";
import type { PaneWatchEndReason, PaneWatchStatus } from "@plannotator/core/pane-watch";

import { subscribePaneWatch, type PaneWatchSubscribe } from "../live/paneWatchStream";

/** Standard xterm palette. Terminal colours are the pane's, not the app theme's. */
const PALETTE_16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#f5f5f5",
];

function paletteColor(index: number): string {
  if (index < 16) return PALETTE_16[index]!;
  if (index < 232) {
    const value = index - 16;
    const level = (component: number): number => (component === 0 ? 0 : 55 + component * 40);
    const r = level(Math.floor(value / 36) % 6);
    const g = level(Math.floor(value / 6) % 6);
    const b = level(value % 6);
    return `rgb(${r},${g},${b})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

function cssColor(color: AnsiColor | null): string | undefined {
  if (!color) return undefined;
  return color.kind === "palette" ? paletteColor(color.index) : `rgb(${color.r},${color.g},${color.b})`;
}

/**
 * Font bounds for the fit-then-scroll rule. Below `MIN` a terminal stops being
 * readable, so narrow screens shrink to the floor and then scroll — the real
 * pane is never resized to make it fit.
 */
const MIN_FONT_PX = 7;
const MAX_FONT_PX = 13;
/** Advance width of a monospace glyph as a fraction of font size. */
const CHAR_WIDTH_RATIO = 0.6;

/** Fit `columns` into `availableWidth`, clamped to the readable range. */
export function watchFontSize(columns: number, availableWidth: number): number {
  if (columns <= 0 || availableWidth <= 0) return MAX_FONT_PX;
  const ideal = availableWidth / (columns * CHAR_WIDTH_RATIO);
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, Math.floor(ideal)));
}

/**
 * The line a terminal state shows. `pane-gone` is the product's `Session
 * ended`; the other end reasons get their own honest sentence rather than being
 * dressed up as a finished session, while staying in the same terminal state so
 * no new UI state is introduced.
 */
export function watchEndedMessage(reason: PaneWatchEndReason): string {
  switch (reason) {
    case "pane-gone":
      return "Session ended";
    case "unauthorized":
      return "This pane is no longer live";
    case "capacity":
      return "Too many live terminal watches are open";
    case "host-error":
      return "Live terminal watch stopped";
  }
}

export interface LivePaneWatchOverlayProps {
  /** The pane chosen when Watch opened. Pinned: focus changes never retarget it. */
  paneId: string;
  /** Human identity for the header, e.g. `firstmate · t3H`. */
  paneLabel: string;
  onClose: () => void;
  /** Injectable so the overlay can be exercised against its public contract. */
  subscribe?: PaneWatchSubscribe;
}

export function LivePaneWatchOverlay({
  paneId,
  paneLabel,
  onClose,
  subscribe = subscribePaneWatch,
}: LivePaneWatchOverlayProps): React.ReactElement {
  const [status, setStatus] = React.useState<PaneWatchStatus>("connecting");
  const [screen, setScreen] = React.useState<string | null>(null);
  const [endReason, setEndReason] = React.useState<PaneWatchEndReason | null>(null);
  const [availableWidth, setAvailableWidth] = React.useState(() =>
    typeof window === "undefined" ? 390 : window.innerWidth);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = (): void => setAvailableWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Pinned to the pane captured at open. `paneId` is in the dependency list for
  // correctness, but App never changes it for a mounted overlay — watching a
  // different pane requires closing this one and choosing again.
  React.useEffect(() => {
    const unsubscribe = subscribe(paneId, {
      onStatus: (next) => {
        setStatus(next);
        // Losing the connection must take the screen down with it.
        if (next === "reconnecting" || next === "connecting") setScreen(null);
      },
      onEvent: (event) => {
        if (event.type === "frame") setScreen(event.ansi);
        if (event.type === "ended") {
          setEndReason(event.reason);
          setScreen(null);
        }
      },
    });
    return unsubscribe;
  }, [paneId, subscribe]);

  const lines: AnsiLine[] = React.useMemo(
    () => (screen === null ? [] : parseAnsiScreen(screen)),
    [screen],
  );
  const columns = React.useMemo(
    () => lines.reduce((widest, line) => {
      const width = line.reduce((total, run) => total + run.text.length, 0);
      return width > widest ? width : widest;
    }, 0),
    [lines],
  );
  const fontSize = watchFontSize(columns, availableWidth);

  const ended = status === "ended";
  const reconnecting = status === "reconnecting" || status === "connecting";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Live terminal — ${paneLabel}`}
      // `h-screen h-[100dvh]` is the app's existing dynamic-viewport idiom (see
      // the root element in App.tsx): `h-screen` is the fallback, `100dvh` wins
      // where supported. It matters most here — mobile browser chrome makes
      // `100vh` overshoot exactly the area the captain can actually see.
      className="fixed inset-0 z-50 flex h-screen h-[100dvh] w-screen flex-col bg-background"
      data-testid="live-pane-watch-overlay"
    >
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        {/* Pane name and Close, and nothing else. Read-only needs no badge: it
            is guaranteed by there being no write shape on the wire, no write
            member on the host's Herdr access, and no control on this surface —
            a label would only restate what the absence of controls shows. */}
        <span className="truncate text-xs font-medium text-foreground" data-testid="live-pane-watch-label">
          {paneLabel}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/40"
        >
          Close
        </button>
      </div>

      <div
        className="min-h-0 flex-1 bg-black"
        // Horizontal AND vertical overflow stay reachable: the cell grid is
        // preserved, so when the floor font size still does not fit, the screen
        // scrolls rather than being reflowed into something the terminal never
        // drew.
        style={{ overflow: "auto" }}
        data-testid="live-pane-watch-screen"
      >
        {ended && endReason ? (
          <p className="px-3 py-4 text-xs text-muted-foreground" data-testid="live-pane-watch-ended">
            {watchEndedMessage(endReason)}
          </p>
        ) : reconnecting ? (
          <p className="px-3 py-4 text-xs text-muted-foreground" data-testid="live-pane-watch-reconnecting">
            Reconnecting…
          </p>
        ) : (
          <pre
            className="m-0 font-mono"
            // `pre` — never `pre-wrap`. Wrapping would rearrange a layout the
            // terminal already computed in cells, which is the one thing a
            // terminal view must not do to its own output.
            style={{
              whiteSpace: "pre",
              wordBreak: "normal",
              overflowWrap: "normal",
              fontSize: `${fontSize}px`,
              lineHeight: 1.2,
              padding: "6px 8px",
              color: "#e5e5e5",
            }}
            data-testid="live-pane-watch-frame"
          >
            {lines.map((line, lineIndex) => (
              <div key={lineIndex}>
                {line.length === 0
                  ? " "
                  : line.map((run, runIndex) => {
                      // Reverse video swaps the pair once, here. When a side was
                      // "default" it has no colour to swap in, so the default
                      // terminal fg/bg stand in — otherwise an inverted run with
                      // no explicit colours would render as nothing at all.
                      const foreground = cssColor(run.inverse ? run.bg : run.fg)
                        ?? (run.inverse ? "#000000" : undefined);
                      const background = cssColor(run.inverse ? run.fg : run.bg)
                        ?? (run.inverse ? "#e5e5e5" : undefined);
                      return (
                        <span
                          key={runIndex}
                          style={{
                            color: foreground,
                            backgroundColor: background,
                            fontWeight: run.bold ? 700 : undefined,
                            fontStyle: run.italic ? "italic" : undefined,
                            textDecoration: run.underline ? "underline" : undefined,
                            opacity: run.dim ? 0.7 : undefined,
                          }}
                        >
                          {run.text}
                        </span>
                      );
                    })}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
