/**
 * Minimal ANSI screen parser for the read-only **Watch live** terminal view.
 *
 * This is deliberately NOT a terminal emulator, and the difference is a safety
 * property rather than a matter of taste. An emulator (xterm.js and friends) is
 * built around a PTY: it owns a cursor, a keyboard handler, a resize protocol
 * and a write side. Watch must expose none of those. What it needs is far
 * smaller — take one already-rendered visible screen that Herdr hands back as
 * ANSI text and turn it into styled runs — so that is all this does. There is
 * no write path here because there is nothing to write to.
 *
 * Scope: SGR (colour/attribute) sequences are interpreted; every other escape
 * sequence is recognised only well enough to be dropped, so stray control bytes
 * can never leak into rendered text. A `visible`-source read is a screen that
 * Herdr has already laid out, so cursor motion does not need replaying.
 *
 * Colours are returned as data, never as CSS or Tailwind classes: this package
 * is browser-safe and is not scanned by Tailwind, so a class string written
 * here would silently produce no styling at all. The renderer owns the mapping.
 */

/** A 0-255 palette index, or a 24-bit colour. */
export type AnsiColor =
  | { kind: "palette"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number };

/** One run of text sharing a single set of attributes. */
export interface AnsiRun {
  text: string;
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** Reverse video. Applied by swapping fg/bg at render time. */
  inverse: boolean;
}

/** One screen line. An empty line is an empty run list, never a missing entry. */
export type AnsiLine = AnsiRun[];

interface AnsiStyle {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const ESC = "\x1b";

const DEFAULT_STYLE: AnsiStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
};

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return a.bold === b.bold
    && a.dim === b.dim
    && a.italic === b.italic
    && a.underline === b.underline
    && a.inverse === b.inverse
    && sameColor(a.fg, b.fg)
    && sameColor(a.bg, b.bg);
}

function sameColor(a: AnsiColor | null, b: AnsiColor | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "palette" && b.kind === "palette") return a.index === b.index;
  if (a.kind === "rgb" && b.kind === "rgb") return a.r === b.r && a.g === b.g && a.b === b.b;
  return false;
}

/**
 * Apply one SGR parameter list. Returns the next style.
 *
 * Extended colour (`38`/`48`) consumes following parameters, so this walks the
 * list with an index rather than mapping over it.
 */
function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const code = params[i]!;
    if (code === 0) { next = { ...DEFAULT_STYLE }; continue; }
    if (code === 1) { next.bold = true; continue; }
    if (code === 2) { next.dim = true; continue; }
    if (code === 3) { next.italic = true; continue; }
    if (code === 4) { next.underline = true; continue; }
    if (code === 7) { next.inverse = true; continue; }
    if (code === 21 || code === 22) { next.bold = false; next.dim = false; continue; }
    if (code === 23) { next.italic = false; continue; }
    if (code === 24) { next.underline = false; continue; }
    if (code === 27) { next.inverse = false; continue; }
    if (code >= 30 && code <= 37) { next.fg = { kind: "palette", index: code - 30 }; continue; }
    if (code >= 40 && code <= 47) { next.bg = { kind: "palette", index: code - 40 }; continue; }
    if (code >= 90 && code <= 97) { next.fg = { kind: "palette", index: code - 90 + 8 }; continue; }
    if (code >= 100 && code <= 107) { next.bg = { kind: "palette", index: code - 100 + 8 }; continue; }
    if (code === 39) { next.fg = null; continue; }
    if (code === 49) { next.bg = null; continue; }
    if (code === 38 || code === 48) {
      const mode = params[i + 1];
      if (mode === 5) {
        const index = params[i + 2];
        if (index !== undefined) {
          const color: AnsiColor = { kind: "palette", index: Math.max(0, Math.min(255, index)) };
          if (code === 38) next.fg = color; else next.bg = color;
        }
        i += 2;
        continue;
      }
      if (mode === 2) {
        const r = params[i + 2], g = params[i + 3], b = params[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          const color: AnsiColor = { kind: "rgb", r: clampByte(r), g: clampByte(g), b: clampByte(b) };
          if (code === 38) next.fg = color; else next.bg = color;
        }
        i += 4;
        continue;
      }
      // Unknown extended-colour mode: skip the introducer and keep parsing
      // rather than mis-reading its operands as further attributes.
      i += 1;
      continue;
    }
    // Any other SGR code is simply not supported; ignoring it is correct and
    // strictly better than rendering its digits as terminal text.
  }
  return next;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Parse an ANSI screen into styled lines.
 *
 * Every escape sequence is consumed: SGR updates the style, anything else is
 * dropped. Text is split on `\n`; a `\r` restarts the current line, which is
 * what a terminal would have shown. Trailing `\r` on CRLF input is therefore
 * handled without a special case.
 */
export function parseAnsiScreen(input: string): AnsiLine[] {
  const lines: AnsiLine[] = [];
  let current: AnsiLine = [];
  let style: AnsiStyle = { ...DEFAULT_STYLE };
  let pending = "";

  const flush = (): void => {
    if (!pending) return;
    const last = current[current.length - 1];
    if (last && sameStyle(last, style)) last.text += pending;
    else current.push({ text: pending, ...style });
    pending = "";
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (char === "\n") {
      flush();
      lines.push(current);
      current = [];
      continue;
    }
    if (char === "\r") {
      // CRLF: the `\r` is part of the line terminator and carries no meaning of
      // its own — the `\n` on the next pass ends the line.
      //
      // This is NOT a defensive path, which is what it was originally written
      // as. Herdr's visible read terminates EVERY line with `\r\n`, so treating
      // a carriage return as "rewrite this line" discarded each line's content
      // an instant before the newline emitted it. A 44-line screen rendered as
      // one line — the last, which happened to lack a trailing `\r`.
      if (input[i + 1] === "\n") continue;
      // A bare `\r` really is a carriage return: the line is rewritten from its
      // start, which is what the terminal itself would have displayed.
      pending = "";
      current = [];
      continue;
    }
    if (char === ESC) {
      const next = input[i + 1];
      if (next === "[") {
        // CSI: parameter bytes, then intermediates, then one final byte.
        let end = i + 2;
        while (end < input.length && /[0-9;:?<>=!]/.test(input[end]!)) end++;
        while (end < input.length && /[ -/]/.test(input[end]!)) end++;
        const final = input[end];
        if (final === undefined) { i = input.length; break; }
        if (final === "m") {
          flush();
          const raw = input.slice(i + 2, end);
          const params = raw
            .split(";")
            .map((part) => {
              // Sub-parameters (`38:2:r:g:b`) are flattened; the SGR walker
              // reads them positionally either way.
              return part.split(":");
            })
            .flat()
            .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)))
            .filter((value) => Number.isFinite(value));
          style = applySgr(style, params.length > 0 ? params : [0]);
        }
        i = end;
        continue;
      }
      if (next === "]") {
        // OSC: runs to BEL or ST. Its payload is never terminal text.
        let end = i + 2;
        while (end < input.length) {
          if (input[end] === "\x07") break;
          if (input[end] === ESC && input[end + 1] === "\\") { end++; break; }
          end++;
        }
        i = Math.min(end, input.length - 1);
        continue;
      }
      // Two-byte escape (or a stray ESC at the very end); drop it.
      i += 1;
      continue;
    }
    // Remaining C0 control bytes carry no visible content. Tab is kept because
    // a screen read can legitimately contain one and it is width-bearing.
    if (char !== "\t" && char < " ") continue;

    pending += char;
  }

  flush();
  lines.push(current);
  return lines;
}

/** Plain text of a parsed screen — used for assertions and a11y text, not layout. */
export function ansiScreenText(lines: AnsiLine[]): string {
  return lines.map((line) => line.map((run) => run.text).join("")).join("\n");
}
