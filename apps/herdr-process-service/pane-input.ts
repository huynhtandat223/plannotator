/**
 * Host side of typing into a watched pane: validate one event, map it to an
 * exact Herdr argument vector, and run it in order.
 *
 * The observation transport (`pane-watch.ts`) stays write-free; this is a
 * separate module for the same reason it is a separate endpoint. Nothing here
 * confirms delivery: there is no busy gate, no turn-start poll, and no retry.
 * A caller that needs those has `/api/instruction`. What this offers instead is
 * the one thing that path cannot — putting characters in the pane's composer
 * WITHOUT pressing anything, so the agent's own completion popup opens and the
 * captain operates it with keys they choose.
 *
 * Ordering is the property that would be silently wrong if left to chance.
 * `text` followed by `key` is the entire interaction ("type /mod, then Tab"),
 * and two overlapping `execFile` calls have no defined arrival order — a slow
 * `send-text` would let the Tab land in an empty composer. So calls are
 * serialised PER PANE by {@link paneInputQueue}. Per pane rather than globally:
 * two watched panes are independent, and one wedged CLI call must not stall the
 * other.
 */

import {
  isPaneInputKey,
  paneInputTextRefusal,
  type PaneInputKey,
  type PaneInputRequest,
} from "../../packages/core/pane-input";

/**
 * Browser key enum → Herdr's own key name.
 *
 * The host owns this table so the browser can never name a Herdr key directly.
 * Adding a row is a deliberate act; an unmapped key cannot be requested,
 * because {@link paneInputDelivery} validates against the enum first.
 */
const HERDR_KEY_NAMES: Record<PaneInputKey, string> = {
  enter: "enter",
  tab: "tab",
  escape: "escape",
  backspace: "backspace",
  "arrow-up": "up",
  "arrow-down": "down",
  "arrow-left": "left",
  "arrow-right": "right",
};

export type PaneInputRefusal = { error: string };

/**
 * Validate one request body against the live pane list.
 *
 * Returns the exact request to run, or the reason it will not run. Never
 * normalises a malformed event into a different one: a body that does not say
 * precisely what it wants is refused, not guessed at.
 */
export function paneInputDelivery(
  body: Record<string, unknown> | null,
  livePaneIds: readonly string[],
): PaneInputRequest | PaneInputRefusal {
  const paneId = typeof body?.paneId === "string" ? body.paneId.trim() : "";
  if (!paneId) return { error: "A pane id is required." };
  if (!livePaneIds.includes(paneId)) {
    return { error: "That pane is no longer live. Close Watch and reopen it on a current pane." };
  }
  const kind = body?.kind;
  if (kind === "key") {
    // Validated against the closed enum before anything is mapped, so an
    // unknown key name never reaches the Herdr table.
    if (!isPaneInputKey(body?.key)) return { error: "That key cannot be sent." };
    return { paneId, kind: "key", key: body.key };
  }
  if (kind === "text") {
    if (typeof body?.text !== "string") return { error: "Text is required." };
    const refusal = paneInputTextRefusal(body.text);
    if (refusal) return { error: refusal };
    return { paneId, kind: "text", text: body.text };
  }
  return { error: "A text or key event is required." };
}

/** The exact argument vector for a validated request. `execFile`, never a shell. */
export function paneInputArgs(request: PaneInputRequest): string[] {
  return request.kind === "text"
    ? ["pane", "send-text", request.paneId, request.text]
    : ["pane", "send-keys", request.paneId, HERDR_KEY_NAMES[request.key]];
}

/**
 * Per-pane serial executor.
 *
 * Each pane gets a promise chain; a new call is appended to its predecessor
 * regardless of how that predecessor settled, so one failed key never wedges
 * the pane's queue. Chains are dropped once drained so a long-lived host does
 * not accumulate one entry per pane it has ever seen.
 */
export function paneInputQueue() {
  const chains = new Map<string, Promise<void>>();
  return {
    run<T>(paneId: string, task: () => Promise<T>): Promise<T> {
      const previous = chains.get(paneId) ?? Promise.resolve();
      // `then(task, task)`: the successor runs whether or not its predecessor
      // threw. A failed key must not wedge the pane's queue forever.
      const result = previous.then(task, task);
      // The chain's copy swallows rejection; the returned promise keeps it, so
      // the caller still reports the failure to the captain.
      const chain = result.then(() => undefined, () => undefined);
      chains.set(paneId, chain);
      void chain.then(() => {
        if (chains.get(paneId) === chain) chains.delete(paneId);
      });
      return result;
    },
    /** Panes with work queued or in flight. Test seam; not part of the wire. */
    get pending(): number {
      return chains.size;
    },
  };
}
