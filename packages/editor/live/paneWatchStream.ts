/**
 * Browser side of the read-only **Watch live** transport.
 *
 * The overlay talks to this contract rather than to `EventSource` directly, for
 * one reason that matters more than testability: a subscription that can only
 * hand back `PaneWatchEvent`s cannot grow a send method by accident. There is
 * no `send`, no socket handle, and no way for the overlay to reach the wire.
 *
 * Reconnect is deliberately naive — drop everything, open a new stream, take
 * whatever screen the host reads next. Watch is a view of *now*, so there is no
 * cursor to resume from and no frames to replay. The one non-negotiable part is
 * that `reconnecting` is reported to the consumer, because a stale screen left
 * on display during an outage is a lie about what the agent is doing.
 */

import { paneWatchUrl, type PaneWatchEvent, type PaneWatchStatus } from "@plannotator/core/pane-watch";

export interface PaneWatchHandlers {
  onEvent: (event: PaneWatchEvent) => void;
  onStatus: (status: PaneWatchStatus) => void;
}

/**
 * Subscribe to one pane's screen. Returns an unsubscribe that must release the
 * connection — closing the overlay has to stop host-side capture immediately.
 */
export type PaneWatchSubscribe = (paneId: string, handlers: PaneWatchHandlers) => () => void;

/** Backoff between reconnect attempts, so a flapping mobile link is not a hot loop. */
const RECONNECT_DELAY_MS = 1_000;

/**
 * Default `EventSource` implementation.
 *
 * `EventSource` reconnects on its own, but its retry is invisible to the
 * consumer — which is exactly the failure mode the product forbids (an old
 * screen still on display, looking live). So each transport error closes the
 * stream, reports `reconnecting`, and opens a fresh one.
 */
export const subscribePaneWatch: PaneWatchSubscribe = (paneId, handlers) => {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** An `ended` pane is terminal: never reconnect to a pane Herdr says is gone. */
  let ended = false;

  const open = (): void => {
    if (stopped || ended) return;
    const stream = new EventSource(paneWatchUrl(paneId));
    source = stream;

    stream.addEventListener("pane-watch", (event) => {
      if (stopped) return;
      let parsed: PaneWatchEvent;
      try {
        parsed = JSON.parse((event as MessageEvent<string>).data) as PaneWatchEvent;
      } catch {
        return;
      }
      if (parsed.type === "ready") handlers.onStatus("watching");
      if (parsed.type === "ended") {
        ended = true;
        handlers.onStatus("ended");
        handlers.onEvent(parsed);
        stream.close();
        return;
      }
      handlers.onEvent(parsed);
    });

    stream.onerror = () => {
      if (stopped || ended) return;
      stream.close();
      source = null;
      // Tell the consumer BEFORE the gap, so the stale screen comes down at the
      // moment the connection is known to be bad rather than when it returns.
      handlers.onStatus("reconnecting");
      retry = setTimeout(open, RECONNECT_DELAY_MS);
    };
  };

  handlers.onStatus("connecting");
  open();

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    retry = null;
    source?.close();
    source = null;
  };
};
