/**
 * Full-screen **Watch live** overlay for ONE Herdr pane: an observation stream,
 * plus one message composer that is deliberately not part of it.
 *
 * Mobile portrait is the primary layout: the captain reaches this over a
 * Tailscale URL on a phone, so the terminal gets the dynamic viewport and the
 * chrome above it is exactly two things — which pane this is, and Close.
 *
 * **The terminal half is still an observation surface, and that is enforced by
 * shape rather than by discipline.** The screen region contains no control, no
 * focusable element and nothing that can receive a keystroke; the transport it
 * reads from (`../live/paneWatchStream`) has no send method to call. Nothing
 * typed below is forwarded as keys, and there is still no paste, resize, focus,
 * zoom, font, settings, copy, download or export affordance anywhere.
 *
 * **The footer is the only write surface, and it writes MESSAGES, not
 * keystrokes.** One complete ordinary-text message goes through the host's
 * normal message boundary — the same boundary the document viewer's composer
 * uses — so a terminal that cannot be typed into gains a way to be *told*
 * something. Plain Enter inserts a newline; ⌘/Ctrl+Enter sends. Text that
 * happens to begin with `/` stays literal text: advertised commands are a
 * separate control with their own explicit Run action, so nothing the captain
 * types can execute by itself.
 *
 * What the footer says about delivery comes from the capability registry
 * (`@plannotator/core/live-pane-agents`) and never from an agent's name, so
 * every kind — including one this build has never seen — gets copy that matches
 * what its mechanism actually guarantees. The two mechanisms are not equal and
 * the receipts never pretend otherwise: an extension send is **queued** (the
 * claim happens out of band and is never reported back), a composer send is
 * typed and either turn-confirmed or explicitly unconfirmed. An unconfirmed
 * send offers no retry — retyping is how a message gets delivered twice.
 *
 * The display states are a truthfulness contract, not decoration: a frame
 * replaces the previous frame outright; `Reconnecting…` REMOVES the screen (an
 * old terminal presented as live is worse than none); and a pane Herdr no
 * longer reports is terminal — `Session ended`, Close, and no composer, because
 * there is no longer anything to send to.
 */

import React from "react";

import { parseAnsiScreen, type AnsiColor, type AnsiLine } from "@plannotator/core/ansi-screen";
import {
  COMPOSER_BUSY_REASON,
  COMPOSER_UNREADABLE_REASON,
  composerCommandTextRefusal,
  livePaneAgentLabel,
  livePaneSendCopy,
  supportsLivePaneCapability,
} from "@plannotator/core/live-pane-agents";
import type { PaneWatchEndReason, PaneWatchStatus } from "@plannotator/core/pane-watch";

import { describeLiveSendReceipt, type LiveDeliveryReceipt } from "../liveResponseFeedback";
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
 * Font bounds for the fit-then-scroll rule.
 *
 * `MIN` is the smallest size at which a terminal is still *readable*, and that
 * is the only thing it may be tuned against. It was 7px, which is what a real
 * pane produces on a phone — a 215-column screen in a 390px viewport wants
 * 390/(215*0.6) ≈ 3px, so the clamp bottoms out — and 7px on a phone is not
 * legible. Worse, the screen still overflowed 2.3x, so shrinking past the
 * readable range bought nothing: once the captain has to scroll anyway, an
 * unreadable font is strictly the worse trade. Below-readable is not a smaller
 * version of readable; it is a blank screen with ink on it.
 */
const MIN_FONT_PX = 11;
const MAX_FONT_PX = 13;
/** Advance width of a monospace glyph as a fraction of font size. */
const CHAR_WIDTH_RATIO = 0.6;

/**
 * Fit `columns` into `availableWidth`, clamped to the readable range.
 *
 * Narrow content shrinks only as far as it must; anything wider than the
 * viewport can hold at `MIN_FONT_PX` stays at `MIN_FONT_PX` and scrolls.
 */
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

/** One advertised command, exactly as the pane's own session published it. */
export interface LivePaneWatchCommand {
  name: string;
  description?: string;
}

export interface LivePaneWatchOverlayProps {
  /** The pane chosen when Watch opened. Pinned: focus changes never retarget it. */
  paneId: string;
  /** Human identity for the header, e.g. `firstmate · t3H`. */
  paneLabel: string;
  /** Herdr's agent kind for the pinned pane, captured at open. Resolves all delivery copy. */
  agent?: string;
  /**
   * The pinned pane's CURRENT agent state. Refreshed for the pinned pane id —
   * never re-read from whatever is selected behind the overlay — because the
   * composer refuses to type into a busy pane and a frozen status would make
   * that refusal lie in both directions.
   */
  agentStatus?: "working" | "idle" | "blocked" | "unknown";
  /** The extension session identity captured at open. Sends are pinned to it. */
  piSessionId?: string;
  /**
   * True when the pinned pane's session has been replaced since Watch opened.
   * The captured session and everything it advertised (its command list above
   * all) belong to a session that no longer exists, so both write actions
   * refuse visibly instead of silently addressing its replacement.
   */
  sessionReplaced?: boolean;
  /** Commands this pane's captured session advertised. Never a free-text command line. */
  commands?: LivePaneWatchCommand[];
  /**
   * Send one complete ordinary message. Resolves with the host's receipt;
   * rejects with the refusal reason, which leaves the draft untouched.
   * Absent → no composer, for hosts that do not offer sending at all.
   */
  onSendMessage?: (text: string) => Promise<LiveDeliveryReceipt>;
  /** Run one advertised command. Separate action, separate boundary, separate receipt. */
  onRunCommand?: (command: string) => Promise<void>;
  onClose: () => void;
  /** Injectable so the overlay can be exercised against its public contract. */
  subscribe?: PaneWatchSubscribe;
}

type WatchResultTone = "ok" | "warn" | "error";
type WatchResult = { tone: WatchResultTone; title: string; detail: string };

const RESULT_TONE_CLASS: Record<WatchResultTone, string> = {
  ok: "text-muted-foreground",
  warn: "text-yellow-600 dark:text-yellow-500",
  error: "text-destructive",
};

/** Human label for the pinned pane's agent state, for the visible target line. */
export function watchStatusLabel(status: LivePaneWatchOverlayProps["agentStatus"]): string {
  switch (status) {
    case "working":
      return "Working";
    case "blocked":
      return "Blocked";
    case "idle":
      return "Idle";
    default:
      return "Status unknown";
  }
}

/**
 * Why this pane cannot be messaged right now, or null when it can.
 *
 * Ordered most permanent first, because that is the order a reader needs: a
 * kind that can never be messaged should never be told to wait for it to go
 * idle. Every reason is one the host itself would answer with, so a refusal
 * shown here and a refusal returned by the server read identically.
 */
const SESSION_REPLACED_REASON =
  "This pane's agent session has been replaced since Watch opened. Close Watch and reopen it on the current session — Plannotator will not send to a session you did not choose.";

/**
 * Why an advertised command cannot be run right now, or null when it can.
 *
 * A command list is published by ONE session, and this surface pins the session
 * it saw so the host can refuse a replacement. Without a captured session there
 * is nothing to pin: the request would omit `sessionId`, which the host reads as
 * "resolve the current registration" — the deliberate opt-out for callers that
 * pick a command at click time. That is right for the command palette and wrong
 * here, so the missing session disables the control instead of quietly becoming
 * the unpinned path.
 */
export function watchCommandBlockedReason(input: {
  piSessionId?: string;
  sessionReplaced?: boolean;
}): string | null {
  if (!input.piSessionId) {
    return "Plannotator did not capture the agent session that advertised these commands, so it cannot guarantee one runs against the session you are watching.";
  }
  if (input.sessionReplaced) return SESSION_REPLACED_REASON;
  return null;
}

export function watchSendBlockedReason(input: {
  agent?: string;
  agentStatus?: LivePaneWatchOverlayProps["agentStatus"];
  piSessionId?: string;
  sessionReplaced?: boolean;
}): string | null {
  const copy = livePaneSendCopy(input.agent);
  if (copy.unavailableReason) return copy.unavailableReason;
  if (input.sessionReplaced) return SESSION_REPLACED_REASON;
  if (copy.mechanism === "pi-extension" && !input.piSessionId) {
    return "Plannotator did not capture an agent session for this pane when Watch opened, so it cannot guarantee the message reaches the session you are watching.";
  }
  if (copy.mechanism === "herdr-composer") {
    if (input.agentStatus === "working" || input.agentStatus === "blocked") return COMPOSER_BUSY_REASON;
    if (input.agentStatus !== "idle") return COMPOSER_UNREADABLE_REASON;
  }
  return null;
}

export function LivePaneWatchOverlay({
  paneId,
  paneLabel,
  agent,
  agentStatus,
  piSessionId,
  sessionReplaced = false,
  commands,
  onSendMessage,
  onRunCommand,
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

  // ---- Composer ---------------------------------------------------------
  // Draft, in-flight and result live here and nowhere else. They are entirely
  // independent of the frame stream above: a screen update must never disturb
  // half-typed text, and a send must never depend on a frame having arrived.
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<WatchResult | null>(null);
  const [command, setCommand] = React.useState("");
  const [runningCommand, setRunningCommand] = React.useState(false);
  const [commandResult, setCommandResult] = React.useState<WatchResult | null>(null);

  const sendCopy = livePaneSendCopy(agent);
  const agentLabel = livePaneAgentLabel(agent);
  const blockedReason = watchSendBlockedReason({ agent, agentStatus, piSessionId, sessionReplaced });
  // Refusal that depends on what is TYPED rather than on the pane, so it has to
  // be recomputed per keystroke and cannot live in `watchSendBlockedReason`.
  // Shown as the captain types, before they commit to sending.
  const draftBlockedReason = composerCommandTextRefusal(agent, draft);
  const advertisedCommands = commands ?? [];
  const commandsOffered = Boolean(onRunCommand)
    && supportsLivePaneCapability(agent, "commands")
    && advertisedCommands.length > 0;
  const commandBlockedReason = watchCommandBlockedReason({ piSessionId, sessionReplaced });

  const submitMessage = React.useCallback(async () => {
    // Guards the button's `disabled` also covers — repeated here because
    // ⌘/Ctrl+Enter reaches this without touching the button at all, and a
    // second in-flight send is exactly how one message becomes two.
    if (!onSendMessage || sending) return;
    // Trim decides only whether there is anything to send. What gets sent is the
    // captain's exact text: leading indentation in a pasted snippet, a trailing
    // blank line before a signature, and every space between are content, and
    // this surface has no business editing prose on its way out.
    if (!draft.trim()) {
      setResult({ tone: "error", title: "Nothing to send", detail: "Type a message first." });
      return;
    }
    if (blockedReason) {
      setResult({ tone: "error", title: "Message not sent", detail: blockedReason });
      return;
    }
    // Re-checked here and not only on the button: ⌘/Ctrl+Enter never touches it.
    if (draftBlockedReason) {
      setResult({ tone: "error", title: "Message not sent", detail: draftBlockedReason });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const described = describeLiveSendReceipt(await onSendMessage(draft), agentLabel, sendCopy.mechanism);
      setResult({ tone: described.warning ? "warn" : "ok", title: described.title, detail: described.description });
      // Only a send the host accepted clears the draft. Every other path below
      // keeps it, so a refusal never costs the captain their message.
      setDraft("");
    } catch (error) {
      setResult({
        tone: "error",
        title: "Message not sent",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSending(false);
    }
  }, [onSendMessage, sending, draft, blockedReason, draftBlockedReason, agentLabel, sendCopy.mechanism]);

  const runCommand = React.useCallback(async () => {
    if (!onRunCommand || runningCommand || !command) return;
    const blocked = watchCommandBlockedReason({ piSessionId, sessionReplaced });
    if (blocked) {
      setCommandResult({ tone: "error", title: "Command not run", detail: blocked });
      return;
    }
    setRunningCommand(true);
    setCommandResult(null);
    try {
      await onRunCommand(command);
      // A command receipt is deliberately not phrased as message delivery: the
      // host only started it in the pane.
      setCommandResult({ tone: "ok", title: `Command started — /${command}`, detail: `${agentLabel} is handling it in this pane.` });
    } catch (error) {
      setCommandResult({
        tone: "error",
        title: "Command could not be run",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunningCommand(false);
    }
  }, [onRunCommand, runningCommand, command, sessionReplaced, piSessionId, agentLabel]);

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

      {/* The one write surface. Visually and structurally outside the screen
          region above, which is what keeps "observe" and "tell" separate: this
          sends a whole message through the host's message boundary, and can
          never emit a keystroke into the terminal. Absent once the watch has
          ended — a composer under a dead pane offers something that cannot
          happen. */}
      {onSendMessage && !ended && (
        <div
          className="flex flex-shrink-0 flex-col gap-2 border-t border-border px-3 py-2"
          data-testid="live-pane-watch-composer"
        >
          {/* Pane, agent kind, live state and delivery mechanism, in visible
              text — every one of them is something a captain needs before
              deciding whether to trust the send, and none of them is carried by
              an icon alone. */}
          <p className="text-[11px] leading-tight text-muted-foreground" data-testid="live-pane-watch-target">
            <span className="font-medium text-foreground">Message this pane</span>
            {` · ${paneLabel} · ${agentLabel} · ${watchStatusLabel(agentStatus)}`}
            {sendCopy.note ? ` · ${sendCopy.note}` : ""}
          </p>

          {blockedReason ? (
            <p className="text-[11px] leading-snug text-destructive" data-testid="live-pane-watch-blocked">
              {blockedReason}
            </p>
          ) : sendCopy.caveat ? (
            <p className="text-[11px] leading-snug text-muted-foreground" data-testid="live-pane-watch-caveat">
              {sendCopy.caveat}
            </p>
          ) : null}

          {/* A kind with no delivery mechanism stays read-only in the literal
              sense: it is told why, and given nothing to type into. A disabled
              textarea would still be an input on a surface that has none. */}
          {sendCopy.mechanism !== null && (
            <>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                // ⌘/Ctrl+Enter sends; plain Enter is left entirely alone so it
                // inserts a newline. This is prose, and prose has paragraphs.
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submitMessage();
                  }
                }}
                rows={3}
                placeholder={`Type a message for ${agentLabel}…`}
                aria-label={`Message ${paneLabel}`}
                // `resize-none`: the footer is fixed, and a draggable handle here
                // would take the terminal's height on the screen where it is
                // scarcest. Longer messages scroll inside the box instead.
                className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="live-pane-watch-input"
              />

              {/* Appears the moment a `/` or `$` is typed, not after a failed
                  send: the captain should learn this before writing a message
                  they cannot send, and the refusal names where to go instead. */}
              {!blockedReason && draftBlockedReason && (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-[11px] leading-snug text-destructive"
                  data-testid="live-pane-watch-draft-blocked"
                >
                  {draftBlockedReason}
                </p>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  ⌘/Ctrl+Enter to send · Enter adds a line
                </span>
                <button
                  type="button"
                  onClick={() => void submitMessage()}
                  // Disabled for the duration of its own request: a second click
                  // during the round trip is a second message, and neither
                  // mechanism can take one back.
                  disabled={sending || Boolean(blockedReason) || Boolean(draftBlockedReason)}
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/40 disabled:opacity-50"
                  data-testid="live-pane-watch-send"
                >
                  {sending ? "Sending…" : "Send message"}
                </button>
              </div>

              {result && (
                <p
                  role="status"
                  aria-live="polite"
                  className={`text-[11px] leading-snug ${RESULT_TONE_CLASS[result.tone]}`}
                  data-testid="live-pane-watch-result"
                >
                  <span className="font-medium">{result.title}</span>
                  {` — ${result.detail}`}
                </p>
              )}

              {/* Commands are secondary, advertised-only and explicit. They are a
                  separate control with a separate action and a separate boundary,
                  precisely so that nothing typed above — including text that starts
                  with `/` — can ever be interpreted as one. */}
              {commandsOffered && (
                <div className="flex flex-col gap-1 border-t border-border/60 pt-2" data-testid="live-pane-watch-commands">
                  <label className="text-[11px] text-muted-foreground" htmlFor={`watch-command-${paneId}`}>
                    Commands this pane advertises
                  </label>
                  {commandBlockedReason && (
                    <p className="text-[11px] leading-snug text-destructive" data-testid="live-pane-watch-command-blocked">
                      {commandBlockedReason}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <select
                      id={`watch-command-${paneId}`}
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                      className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                      data-testid="live-pane-watch-command-select"
                    >
                      <option value="">Choose a command…</option>
                      {advertisedCommands.map((advertised) => (
                        <option key={advertised.name} value={advertised.name}>
                          {`/${advertised.name}`}
                          {advertised.description ? ` — ${advertised.description}` : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void runCommand()}
                      // Choosing a command never runs it; only this does.
                      disabled={!command || runningCommand || Boolean(commandBlockedReason)}
                      className="shrink-0 rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/40 disabled:opacity-50"
                      data-testid="live-pane-watch-run-command"
                    >
                      {runningCommand ? "Running…" : command ? `Run /${command}` : "Run command"}
                    </button>
                  </div>
                  {commandResult && (
                    <p
                      role="status"
                      aria-live="polite"
                      className={`text-[11px] leading-snug ${RESULT_TONE_CLASS[commandResult.tone]}`}
                      data-testid="live-pane-watch-command-result"
                    >
                      <span className="font-medium">{commandResult.title}</span>
                      {` — ${commandResult.detail}`}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
