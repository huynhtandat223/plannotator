/**
 * Herdr composer delivery: send a message to a live pane whose agent kind has
 * no Plannotator extension, by typing into its composer through Herdr and
 * submitting with Enter.
 *
 * This is the SECOND delivery mechanism, selected per agent kind by
 * `feedbackDelivery` in `@plannotator/core/live-pane-agents`. It is weaker than
 * the Pi extension path on purpose-honoured guarantees:
 *
 * - It types keystrokes; it cannot prove which session is active in the pane.
 * - It confirms delivery only by Herdr's native agent state observing a turn
 *   start — never by reading the composer row back.
 * - It refuses to send while the agent is mid-turn: a busy agent queues typed
 *   text invisibly and no turn-start confirmation is possible, so a retry after
 *   a spurious failure would deliver twice.
 *
 * The sequencing below is not guesswork — it encodes behaviour firstmate
 * verified empirically against real Herdr + real agent TUIs
 * (`firstmate/bin/backends/herdr.sh`, `fm_backend_herdr_send_text_submit`):
 *
 * 1. Send the text literally ONCE (`pane send-text`), then submit with a named
 *    Enter key (`pane send-keys <pane> enter`). On failure, retry Enter ONLY —
 *    NEVER retype the text; retyping duplicates the message.
 * 2. A message starting with `/` or `$` opens a completion popup within ~0.1s,
 *    so a settle delay before the first Enter is mandatory. A popup selection
 *    or placeholder-fill on the first Enter never starts a turn, so the
 *    agent-state confirmation simply fails and the retry Enter submits — no
 *    popup-specific logic needed.
 * 3. Confirmation comes from Herdr's native agent state (`agent get`) observing
 *    a submit-active status (`working` or `blocked`) after Enter, sampled
 *    several times across a budget (real agents observed first-working at
 *    90–490ms after Enter). Composer read-back is what caused firstmate's
 *    2026-07-07 redelivery incident and is deliberately not used.
 *
 * Herdr also exposes an `agent prompt` subcommand; it is NOT used here because
 * its popup/busy/confirmation semantics are unverified, while this sequence's
 * hazards are already paid for.
 */

import { COMPOSER_BUSY_REASON, COMPOSER_UNREADABLE_REASON } from "../../packages/core/live-pane-agents";

export type HerdrCliRunner = (args: string[]) => Promise<{ stdout: string }>;

export type ComposerDeliverySequencing = {
  /** Pre-first-Enter settle for ordinary text. */
  settleMs: number;
  /** Pre-first-Enter settle when the text opens a completion popup (`/` or `$`). */
  popupSettleMs: number;
  /** Enter attempts per delivery. The text itself is typed exactly once. */
  enterAttempts: number;
  /** Confirmation window after each Enter. */
  confirmBudgetMs: number;
  /** Agent-state samples spread across each confirmation window. */
  confirmPolls: number;
};

/**
 * Defaults mirror firstmate's verified values (`fm-send.sh`): settle 0.3s for
 * plain text and 1.2s for popup-opening prefixes, 3 Enter attempts, and a 0.6s
 * per-attempt confirmation budget sampled 6 times.
 */
export const DEFAULT_COMPOSER_SEQUENCING: ComposerDeliverySequencing = {
  settleMs: 300,
  popupSettleMs: 1_200,
  enterAttempts: 3,
  confirmBudgetMs: 600,
  confirmPolls: 6,
};

export type ComposerDeliveryOutcome =
  /** Typed, submitted, and a turn start was observed. */
  | { delivered: true; confirmed: true }
  /** Typed and Enter sent, but no turn start observed — the text may sit in the composer or already be queued. */
  | { delivered: true; confirmed: false; note: string }
  /** Refused or failed before anything could land; nothing needs checking. */
  | { delivered: false; reason: string };

/** Raw `agent get` status → submit vocabulary. `blocked` counts as submit-active: a permission prompt means the turn started. */
export function classifySubmitAgentStatus(raw: string | null): "busy" | "idle" | "unknown" {
  switch (raw) {
    case "working":
    case "blocked":
      return "busy";
    case "idle":
    case "done":
      return "idle";
    default:
      return "unknown";
  }
}

/** One `agent get` read, echoing the raw agent_status, or null on any failure. */
async function agentStatusRaw(run: HerdrCliRunner, paneId: string): Promise<string | null> {
  try {
    const { stdout } = await run(["agent", "get", paneId]);
    const parsed: unknown = JSON.parse(stdout);
    const status = (parsed as { result?: { agent?: { agent_status?: unknown } } })?.result?.agent?.agent_status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

const UNCONFIRMED_NOTE =
  "The message was typed into the pane's composer and Enter was pressed, but the agent was not seen starting a turn. Check the pane directly before sending again — the text may already be waiting there, and resending would deliver it twice.";

/**
 * The two pre-typing refusal reasons now live in the capability registry
 * (`@plannotator/core/live-pane-agents`), because a browser send surface must
 * refuse in the same words without issuing a request. Re-exported here so this
 * module remains the place the host reads them from.
 */
export { COMPOSER_BUSY_REASON, COMPOSER_UNREADABLE_REASON };

/**
 * Deliver `content` to `paneId`'s composer. Callers must pass the FULL final
 * text in one call — this function types it exactly once and will never retype.
 */
export async function deliverViaHerdrComposer(
  paneId: string,
  content: string,
  options: {
    run: HerdrCliRunner;
    sleep?: (ms: number) => Promise<void>;
    sequencing?: ComposerDeliverySequencing;
  },
): Promise<ComposerDeliveryOutcome> {
  const { run } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sequencing = options.sequencing ?? DEFAULT_COMPOSER_SEQUENCING;

  // Baseline gate: only an observably idle agent gets keystrokes. firstmate's
  // verified hazard: a busy agent queues the text and reports failure
  // spuriously, so the send would be retried and delivered twice.
  const baseline = classifySubmitAgentStatus(await agentStatusRaw(run, paneId));
  if (baseline === "busy") return { delivered: false, reason: COMPOSER_BUSY_REASON };
  if (baseline === "unknown") return { delivered: false, reason: COMPOSER_UNREADABLE_REASON };

  // Type the text literally, exactly once.
  try {
    await run(["pane", "send-text", paneId, content]);
  } catch {
    return {
      delivered: false,
      reason: "Herdr could not type into this pane's composer. The pane may have closed — refresh and try again.",
    };
  }

  // Mandatory settle before the first Enter; `/` and `$` prefixes open a
  // completion popup within ~0.1s. `$` is settled unconditionally (unlike
  // firstmate's codex-only scoping) because these sends are not
  // latency-sensitive and the longer settle is harmless for other kinds.
  const opensPopup = content.startsWith("/") || content.startsWith("$");
  await sleep(opensPopup ? sequencing.popupSettleMs : sequencing.settleMs);

  const pollInterval = sequencing.confirmBudgetMs / Math.max(1, sequencing.confirmPolls - 1);
  for (let attempt = 0; attempt < sequencing.enterAttempts; attempt++) {
    // Enter only — never the text again. A first Enter swallowed by a
    // completion popup fills a placeholder without starting a turn, so
    // confirmation fails and the next Enter submits.
    try {
      await run(["pane", "send-keys", paneId, "enter"]);
    } catch {
      // Keep polling: the Enter may still have landed before the CLI error.
    }
    for (let poll = 0; poll < sequencing.confirmPolls; poll++) {
      if (poll > 0) await sleep(pollInterval);
      if (classifySubmitAgentStatus(await agentStatusRaw(run, paneId)) === "busy") {
        return { delivered: true, confirmed: true };
      }
    }
  }
  return { delivered: true, confirmed: false, note: UNCONFIRMED_NOTE };
}
