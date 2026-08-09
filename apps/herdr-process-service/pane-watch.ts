/**
 * Per-viewer, read-only observation transport for **Watch live**.
 *
 * One HTTP connection watches exactly one pane. Nothing here can write to a
 * pane: the module's whole vocabulary is "read the current visible screen and
 * push it to this one viewer". There is no send-text, send-keys, focus, resize,
 * or close primitive, and none may be added — the moment this file can mutate a
 * pane, the observe/control boundary the product is built on stops existing.
 *
 * Three invariants are worth stating because each was a real design decision:
 *
 * 1. **No viewer, no work.** The poll starts when the stream opens and is torn
 *    down (timer, in-flight read, liveness subscription) when it closes. There
 *    is no background capture loop and no server-side history, so a pane that
 *    nobody is watching costs exactly nothing.
 *
 * 2. **The poll is forced by the platform, not chosen for convenience.** On the
 *    supported release (herdr 0.7.3, protocol 16) `events.subscribe` accepts
 *    only `pane.output_matched`, `pane.agent_status_changed` and
 *    `pane.scroll_changed`. There is no subscribable "screen changed" kind, so
 *    the product spec's compatibility clause applies: poll, but only while a
 *    viewer is attached. Frames are revision-gated, so a quiet pane produces no
 *    traffic at all.
 *
 * 3. **Herdr is the only authority for liveness.** Membership is checked
 *    against a fresh snapshot at open, and afterwards through the service's
 *    existing snapshot publisher — never a second poll loop of our own. When a
 *    pane leaves the snapshot the watch ends; a reused pane label must never
 *    resurrect a stale capture.
 *
 * Terminal content is never logged, persisted, or attached to an error. It
 * exists only in the bytes on their way to the one viewer that asked for it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  PANE_WATCH_HEARTBEAT_MS,
  PANE_WATCH_MAX_CONCURRENT,
  PANE_WATCH_POLL_MS,
  PANE_WATCH_SSE_EVENT,
  type PaneWatchEndReason,
  type PaneWatchEvent,
} from "../../packages/core/pane-watch";

/** One current-visible-screen read. `revision` is Herdr's when it supplies one. */
export interface PaneWatchScreen {
  ansi: string;
  revision: number | null;
  truncated: boolean;
}

export interface PaneWatchHerdr {
  /**
   * Read one pane's current visible screen as ANSI. The implementation fixes
   * every argument except the pane id; `signal` must actually abort the read so
   * a disconnect does not leave a subprocess running.
   */
  readScreen(paneId: string, signal: AbortSignal): Promise<PaneWatchScreen>;
  /** Pane ids in a FRESH Herdr snapshot. Used once, to authorize the open. */
  livePaneIds(): Promise<Set<string>>;
  /**
   * Subscribe to the service's existing live-snapshot publisher. Deliberately
   * injected rather than polled here: liveness already has an owner, and a
   * second loop would be both wasteful and a second source of truth.
   */
  subscribeLiveness(listener: (livePaneIds: Set<string>) => void): () => void;
}

/** Watches currently attached, across all viewers. */
let activeWatches = 0;

/** Test/diagnostic accessor: proves "no viewer, no work" from the outside. */
export function activePaneWatchCount(): number {
  return activeWatches;
}

function serialize(event: PaneWatchEvent): string {
  return `event: ${PANE_WATCH_SSE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Open a read-only watch on `paneId` for the life of this HTTP connection.
 *
 * `paneId` is the only caller-supplied value that reaches Herdr, and it only
 * reaches Herdr after being matched against a fresh snapshot — so a browser can
 * name a pane, and nothing else.
 */
export async function startPaneWatchStream(
  request: IncomingMessage,
  response: ServerResponse,
  paneId: string,
  herdr: PaneWatchHerdr,
): Promise<void> {
  let closed = false;
  let reading = false;
  /** Set while the socket is backed up, so frames are dropped rather than queued. */
  let draining = false;
  let lastRevision: number | null = null;
  let lastAnsi: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  /** True only between taking an `activeWatches` slot and giving it back. */
  let counted = false;
  const abort = new AbortController();

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    // Cancels the in-flight `herdr pane read` rather than letting it finish
    // into a socket nobody is reading.
    abort.abort();
    unsubscribe?.();
    unsubscribe = null;
    if (counted) {
      activeWatches--;
      counted = false;
    }
  };

  // Armed BEFORE the first await, and idempotent, because everything above it
  // is optional. Node emits `close` once; a listener added afterwards is never
  // called. Authorization spawns a snapshot subprocess and the first screen read
  // has its own multi-second budget, so a browser closing a tab in that window
  // is ordinary — and if cleanup were attached after it, that disconnect would
  // leave the heartbeat, the liveness subscription, the capacity slot AND the
  // poll timer alive. The poll one matters most: it would keep reading the pane
  // every few hundred ms forever, against a socket nobody is reading, which is
  // exactly the always-on capture loop this transport exists to avoid.
  request.once("close", stop);

  if (activeWatches >= PANE_WATCH_MAX_CONCURRENT) {
    openStream(response);
    end(response, paneId, "capacity");
    stop();
    return;
  }

  let live: Set<string>;
  try {
    live = await herdr.livePaneIds();
  } catch {
    // A snapshot we cannot read is not permission to watch. Fail closed.
    if (closed) return;
    openStream(response);
    end(response, paneId, "unauthorized");
    stop();
    return;
  }
  // The viewer may have vanished while we were authorizing; `stop` has already
  // run, so there is nothing to start and nothing to write to.
  if (closed) return;
  if (!live.has(paneId)) {
    openStream(response);
    end(response, paneId, "unauthorized");
    stop();
    return;
  }

  activeWatches++;
  counted = true;
  openStream(response);
  response.write(serialize({ type: "ready", paneId }));

  heartbeat = setInterval(() => {
    if (!closed) response.write(": keep-alive\n\n");
  }, PANE_WATCH_HEARTBEAT_MS);

  const finish = (reason: PaneWatchEndReason): void => {
    if (closed) return;
    response.write(serialize({ type: "ended", paneId, reason }));
    stop();
    response.end();
  };

  // Herdr's authority, delivered by the publisher the rest of the service
  // already runs. A pane that has left the snapshot ends the watch at once,
  // which takes precedence over anything the next read might return.
  //
  // The subscription is captured LOCALLY first, because a publisher is allowed
  // to deliver its current snapshot synchronously from `subscribeLiveness` —
  // the service's `LiveSnapshotPublisher` does exactly that. If that first
  // delivery already says the pane is gone, `stop()` runs before this call has
  // returned anything to unsubscribe with, and assigning afterwards would leave
  // a listener registered on a watch that is already closed, for the lifetime
  // of the process. So: assign it only if we are still open, and otherwise
  // release it immediately.
  const releaseLiveness = herdr.subscribeLiveness((livePaneIds) => {
    if (!closed && !livePaneIds.has(paneId)) finish("pane-gone");
  });
  if (closed) releaseLiveness();
  else unsubscribe = releaseLiveness;

  response.on("drain", () => {
    draining = false;
  });

  const tick = async (): Promise<void> => {
    if (closed || reading) return;
    // While the client is behind, skip this screen entirely. Watch is a view of
    // now: a superseded frame has no value, so dropping it is strictly better
    // than building a backlog the phone has to chew through later.
    if (draining) return;
    reading = true;
    try {
      const screen = await herdr.readScreen(paneId, abort.signal);
      if (closed) return;
      const unchanged = screen.revision !== null
        ? screen.revision === lastRevision
        : screen.ansi === lastAnsi;
      if (!unchanged) {
        lastRevision = screen.revision;
        lastAnsi = screen.ansi;
        const flushed = response.write(serialize({
          type: "frame",
          paneId,
          ansi: screen.ansi,
          revision: screen.revision,
          truncated: screen.truncated,
        }));
        if (!flushed) draining = true;
      }
    } catch {
      if (closed) return;
      // A failed read is usually a pane that has just gone away; ask the
      // authority rather than guessing, and never surface the underlying
      // message (it can quote terminal content).
      try {
        const stillLive = await herdr.livePaneIds();
        if (!stillLive.has(paneId)) {
          finish("pane-gone");
          return;
        }
      } catch {
        finish("host-error");
        return;
      }
    } finally {
      reading = false;
    }
  };

  const schedule = (): void => {
    if (closed) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, PANE_WATCH_POLL_MS);
  };

  // The first screen is read immediately, so the overlay never opens on an
  // unexplained empty terminal. Cleanup is already armed, so a disconnect
  // during this read tears the watch down instead of being scheduled onward.
  await tick();
  if (closed) return;
  schedule();
}

function openStream(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Terminal frames must not be retained by an intermediary any more than by
    // the browser.
    "x-accel-buffering": "no",
  });
  response.setTimeout(0);
}

function end(response: ServerResponse, paneId: string, reason: PaneWatchEndReason): void {
  response.write(serialize({ type: "ended", paneId, reason }));
  response.end();
}
