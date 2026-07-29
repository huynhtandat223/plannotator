/**
 * Presentation helpers for the live Agent Response session switcher rows.
 *
 * A switcher row exists to be scanned: which pane is this, what did it just
 * say, how long ago. Pane text arrives as markdown, so collapsing whitespace
 * alone leaks the syntax into the one line the captain reads — a real row in
 * the live session looked like:
 *
 *   `# 2ndmate-oracle ## fm-oracle · Pane pD > [!WARNING] > **No transcript…`
 *
 * Kept pure (no DOM, no React) so the scanning rules are unit-testable on
 * their own, the way the other live derivations here are.
 */

/** Hard cap for a one-line row preview. Long enough to disambiguate two panes
 * mid-task, short enough that a row never wraps past its single clamped line. */
export const SESSION_PREVIEW_MAX_CHARS = 120;

/** Markdown that only ever appears inside a line. */
function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link → link text
    .replace(/`+([^`]*)`+/g, "$1") // inline code
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, "$2") // italic
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    .replace(/<[^>]+>/g, " "); // raw html tags
}

/** Markdown that is only meaningful at the start of a line. */
function stripLineMarkdown(line: string): string {
  if (/^\s*```/.test(line)) return ""; // fence markers carry no preview value
  let value = line
    .replace(/^\s{0,3}#{1,6}\s+/, "") // heading
    .replace(/^\s{0,3}(?:>\s?)+/, "") // blockquote, including nested
    .replace(/^\s*\[!\w+\]\s*/, "") // GitHub alert marker (`> [!WARNING]`)
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, ""); // list marker
  if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(value)) return ""; // horizontal rule
  return stripInlineMarkdown(value);
}

/**
 * One scannable line of a response: markdown syntax removed, whitespace
 * collapsed, hard-capped. Operates on the ORIGINAL multi-line text, because
 * line-leading syntax (`#`, `>`, `-`) can only be recognised before the
 * newlines are collapsed away.
 */
export function sessionPreview(text: string, maxChars = SESSION_PREVIEW_MAX_CHARS): string {
  const normalized = (text ?? "")
    .split("\n")
    .map(stripLineMarkdown)
    .filter((line) => line.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}…` : normalized;
}

/**
 * Compact age for a session row, so the captain can tell which pane replied
 * most recently without opening it. `null` when the host sent no usable
 * timestamp — the row then simply omits the field rather than guessing.
 */
export function sessionAge(timestamp: string | undefined | null, now: number = Date.now()): string | null {
  if (!timestamp) return null;
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return null;
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The accessible name for a live-pane switcher row.
 *
 * Left to fall out of DOM text order, a row's name was an unpunctuated
 * run-on — measured verbatim on the live surface:
 *
 *   `●firstmate · fm-plannotator-uiux-top10-audit1m4The Close path is confirmed…`
 *
 * The `1m` age ran straight into the `4` unread badge to read "one m four",
 * agent state was carried only by a `●`/`○` glyph with no text equivalent, and
 * the unread count had no unit at all. The switcher is the navigation spine of
 * this surface, so a screen-reader captain got the least usable version of the
 * most important control.
 *
 * Composing the name explicitly — and hiding the decorative parts — makes each
 * field a separate, labelled clause in a fixed order.
 */
export function sessionRowAccessibleName(parts: {
  identity: string;
  /** Agent state, already human-readable, e.g. "Thinking…". */
  activity?: string | null;
  /** Compact age, e.g. "1m". Omitted when the host sent no usable timestamp. */
  age?: string | null;
  unread?: number;
  preview?: string | null;
}): string {
  const clauses: string[] = [parts.identity.trim()];
  if (parts.activity && parts.activity.trim()) clauses.push(parts.activity.trim());
  if (parts.age) {
    // "now" is already a phrase; the rest are durations that need a unit noun.
    clauses.push(parts.age === "now" ? "active now" : `last active ${parts.age} ago`);
  }
  if (parts.unread && parts.unread > 0) {
    clauses.push(`${parts.unread} unread ${parts.unread === 1 ? "response" : "responses"}`);
  }
  const preview = parts.preview?.trim();
  if (preview) clauses.push(`latest: ${preview}`);
  return clauses.join(", ");
}
