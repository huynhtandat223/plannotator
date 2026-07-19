import { isCodeFilePath, parseCodePath } from "./code-file";

export interface ActiveFileMention {
  /** Offset of the `@` marker in the complete editor text. */
  start: number;
  /** Cursor offset in the complete editor text. */
  end: number;
  /** The file portion used to search suggestions. */
  query: string;
  /** A partially or fully typed `:line` / `:start-end` suffix to retain on selection. */
  lineSuffix: string;
}

/**
 * Finds the file mention being typed at `cursor`.
 *
 * File mentions deliberately start at a word boundary, so email addresses and
 * package names in ordinary prose do not open the picker. The line suffix is
 * kept separate: `@src/App.tsx:20-40` searches for `src/App.tsx` while the
 * selected path preserves `:20-40`.
 */
export function findActiveFileMention(text: string, cursor: number): ActiveFileMention | null {
  const end = Math.max(0, Math.min(cursor, text.length));
  const prefix = text.slice(0, end);
  const match = /(?:^|[\s(])@([^\s]*)$/.exec(prefix);
  if (!match) return null;

  const raw = match[1] ?? "";
  const suffixMatch = /^(.*?)(:\d*(?:-\d*)?)?$/.exec(raw);
  const query = suffixMatch?.[1] ?? raw;
  const lineSuffix = suffixMatch?.[2] ?? "";
  const start = end - raw.length - 1;

  return { start, end, query, lineSuffix };
}

/** Replace only the active mention token, retaining an already-typed line suffix. */
export function replaceActiveFileMention(
  text: string,
  mention: ActiveFileMention,
  path: string,
): { text: string; cursor: number } {
  const replacement = `@${path}${mention.lineSuffix}`;
  const nextText = `${text.slice(0, mention.start)}${replacement}${text.slice(mention.end)}`;
  return { text: nextText, cursor: mention.start + replacement.length };
}

export interface FileMentionReference {
  filePath: string;
  line?: number;
  lineEnd?: number;
}

/**
 * Extract explicit `@path[:line[-line]]` mentions from prose. The same
 * boundary rule as the editor keeps email addresses out. Consumers must still
 * authorize and resolve every returned path against their workspace.
 */
export function extractFileMentionReferences(text: string): FileMentionReference[] {
  const references: FileMentionReference[] = [];
  const seen = new Set<string>();
  const mentionPattern = /(?:^|[\s(])@([^\s`]+)/g;
  for (const match of text.matchAll(mentionPattern)) {
    const input = (match[1] ?? "").replace(/[.,;!?)}\]]+$/, "");
    if (!isCodeFilePath(input)) continue;
    const parsed = parseCodePath(input);
    const key = `${parsed.filePath}:${parsed.line ?? ""}:${parsed.lineEnd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(parsed);
  }
  return references;
}
