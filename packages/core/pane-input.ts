/**
 * Wire contract for **typing into** a watched Herdr pane.
 *
 * This is the deliberate counterpart to `pane-watch.ts`, which observes a pane
 * and has no write shape at all. Watch's `Send message` composer delivers one
 * complete message with a receipt; it cannot carry a slash command, because
 * composer delivery presses Enter to submit and a completion popup turns those
 * Enters into blind clicks through whatever dialog the command opens (see
 * `COMPOSER_COMMAND_TEXT_REASON` in `live-pane-agents.ts`).
 *
 * So the command case gets the opposite mechanism: put the characters in the
 * pane's own composer, press nothing, and let the captain drive the agent's
 * NATIVE completion popup — which they can already see, because Watch is
 * streaming the screen — with discrete key presses they choose one at a time.
 *
 * Three properties are load-bearing:
 *
 * 1. **The browser names a pane and a key, never a Herdr verb.** Keys travel as
 *    a closed enum ({@link PANE_INPUT_KEYS}) that the host maps to Herdr's own
 *    key names. A browser cannot ask for a key the host did not choose to
 *    expose, so the allowlist is the whole attack surface.
 * 2. **Text is data and only data.** Control characters are refused
 *    ({@link paneInputTextRefusal}) precisely because Enter, Tab and Escape have
 *    a route of their own; a newline smuggled inside `text` would be a submit
 *    the captain did not press.
 * 3. **Nothing here is assured delivery.** There is no busy gate, no
 *    confirmation, no retry, and no receipt beyond "the CLI call returned". The
 *    captain is looking at the pane; the screen is the acknowledgement. Any
 *    caller that needs a delivery guarantee must use `/api/instruction`.
 */

/** Same-origin endpoint. Stated once so client and host cannot disagree. */
export const PANE_INPUT_PATH = "/api/pane-input";

/**
 * Every key the browser may ask for.
 *
 * Chosen to be exactly what operating a completion popup and an editor line
 * requires. Deliberately absent: modifier chords (Ctrl+C and friends are signals,
 * not input), function keys, and anything that moves, resizes or closes a pane.
 */
export const PANE_INPUT_KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "arrow-right",
] as const;

export type PaneInputKey = (typeof PANE_INPUT_KEYS)[number];

export function isPaneInputKey(value: unknown): value is PaneInputKey {
  return typeof value === "string" && (PANE_INPUT_KEYS as readonly string[]).includes(value);
}

/**
 * Upper bound on one text event.
 *
 * Generous for a command line and its arguments, and small enough that a
 * paste-bomb cannot become a long blocking `pane send-text`. Longer prose has a
 * better route: the composer, which reports whether it arrived.
 */
export const PANE_INPUT_MAX_TEXT = 2_000;

/**
 * Why this text may not be typed into a pane, or null when it may be.
 *
 * Shared by the browser (refuse before the request) and the host (refuse the
 * request), so the captain reads one explanation rather than two.
 */
export function paneInputTextRefusal(text: string): string | null {
  if (text.length === 0) return "Type something first.";
  if (text.length > PANE_INPUT_MAX_TEXT) {
    return `That is longer than ${PANE_INPUT_MAX_TEXT} characters. Send it as a message instead — typing is for short input like a command.`;
  }
  // C0 controls, DEL, and the C1 range. Newline and tab are in here on purpose:
  // both are keys, and a key press is something the captain does deliberately.
  if (/[\u0000-\u001F\u007F-\u009F]/.test(text)) {
    return "Line breaks, tabs and control characters cannot be typed as text. Use the Enter and Tab keys below, which send exactly one key press each.";
  }
  return null;
}

export type PaneInputRequest =
  | { paneId: string; kind: "text"; text: string }
  | { paneId: string; kind: "key"; key: PaneInputKey };
