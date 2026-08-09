/**
 * Wire contract for the optional read-only **Watch live** terminal view of one
 * explicitly selected Herdr pane.
 *
 * This is deliberately a SCREEN contract, not a PTY contract. Herdr exposes a
 * current-visible-screen read (`herdr pane read --source visible --format
 * ansi`), not a raw byte stream, so the smallest truthful unit is a COMPLETE
 * current screen that REPLACES the previous one. That choice is what makes
 * reconnect trivial (read the screen again) and makes "is this live?" a
 * question with an honest answer, instead of a delta log that can silently
 * desynchronise.
 *
 * Two properties of this file are load-bearing and must survive edits:
 *
 * 1. **There is no write shape here.** No key, text, resize, focus, signal, or
 *    lifecycle message exists in the union. A viewer cannot ask for anything;
 *    it can only be told. Adding a client→host message type would turn a
 *    read-only observation transport into a control channel, which is the one
 *    thing the product contract rules out.
 * 2. **The client sends only an opaque pane id.** Never a cwd, socket path,
 *    command, read source, line count, or output format — the host fixes all
 *    of those. See `PANE_WATCH_READ_SOURCE` / `PANE_WATCH_READ_FORMAT`, which
 *    exist so the fixed values are stated once, in browser-safe code, and can
 *    be asserted against.
 *
 * These frames never enter the normal live-review snapshot, `PickerMessage`, or
 * `/api/session/events`. Watch is per viewer and opt-in; broadcasting a watched
 * terminal to every connected browser would be a different (and much worse)
 * product.
 */

/** The only read source the host will ever ask Herdr for. */
export const PANE_WATCH_READ_SOURCE = "visible";
/** The only output format the host will ever ask Herdr for. */
export const PANE_WATCH_READ_FORMAT = "ansi";

/**
 * Cadence of the host's screen poll while at least one viewer is attached.
 *
 * A poll — rather than a subscription — is not a shortcut. On the supported
 * release (herdr 0.7.3, protocol 16) `events.subscribe` accepts exactly
 * `pane.output_matched`, `pane.agent_status_changed` and `pane.scroll_changed`;
 * there is no subscribable "screen changed" kind, and the `pane_output_changed`
 * event exists only on an unfiltered client feed no CLI exposes. The product
 * spec anticipated this and permits a compatibility reader that runs *only for
 * the lifetime of an open Watch*.
 *
 * 250ms is fast enough to read as live on a phone while keeping the worst case
 * at four `herdr pane read` calls per second per watched pane — and, because
 * frames are revision-gated (below), a quiet pane costs nothing downstream.
 */
export const PANE_WATCH_POLL_MS = 250;

/** Per-read subprocess budget. A wedged read must never wedge the watch. */
export const PANE_WATCH_READ_TIMEOUT_MS = 2_000;

/**
 * Hard ceiling on one screen read's stdout. A visible screen is bounded by the
 * pane's own geometry, so this is an anomaly guard, not a normal limit.
 */
export const PANE_WATCH_MAX_FRAME_BYTES = 256 * 1024;

/**
 * Concurrent watches across all viewers. Watch is a deliberate, one-pane-at-a-
 * time action, so this only has to stop a pathological client from opening
 * watches in a loop.
 */
export const PANE_WATCH_MAX_CONCURRENT = 8;

/** SSE comment cadence, so idle proxies do not silently drop a quiet watch. */
export const PANE_WATCH_HEARTBEAT_MS = 20_000;

/**
 * Why a watch ended. `pane-gone` is Herdr's authority speaking: the pane left
 * the live snapshot, so nothing may keep serving its screen. `unauthorized`
 * covers a pane id that is not in a fresh snapshot at open time. `capacity`
 * is `PANE_WATCH_MAX_CONCURRENT`. `host-error` is a read that failed in a way
 * the host could not recover from.
 */
export type PaneWatchEndReason = "pane-gone" | "unauthorized" | "capacity" | "host-error";

/**
 * Host → viewer messages. There is intentionally no viewer → host message.
 *
 * `frame` carries a COMPLETE current screen and replaces whatever was on
 * screen. `revision` is Herdr's own screen revision when it supplies one; the
 * host uses it to suppress re-sending an unchanged screen, and the client may
 * use it only for display-free bookkeeping.
 */
export type PaneWatchEvent =
  | { type: "ready"; paneId: string }
  | { type: "frame"; paneId: string; ansi: string; revision: number | null; truncated: boolean }
  | { type: "ended"; paneId: string; reason: PaneWatchEndReason };

/** SSE event name used for every `PaneWatchEvent`. */
export const PANE_WATCH_SSE_EVENT = "pane-watch";

/** Route the browser opens. The pane id is the ONLY parameter it may supply. */
export const PANE_WATCH_PATH = "/api/pane-watch";

/**
 * Client-visible connection state.
 *
 * `reconnecting` is a product requirement, not a nicety: while the transport is
 * down the previously rendered screen MUST be removed, because an old terminal
 * presented as live is worse than no terminal at all.
 */
export type PaneWatchStatus = "connecting" | "watching" | "reconnecting" | "ended";

/**
 * Build the watch URL for one pane. Centralised so the "opaque pane id and
 * nothing else" rule is enforced in one place rather than at each call site.
 */
export function paneWatchUrl(paneId: string): string {
  return `${PANE_WATCH_PATH}?paneId=${encodeURIComponent(paneId)}`;
}
