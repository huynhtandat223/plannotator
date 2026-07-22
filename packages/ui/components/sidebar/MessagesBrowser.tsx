/**
 * MessagesBrowser — Sidebar list of recent assistant messages.
 *
 * Used by annotate-last. Lets the user pick which assistant message to
 * annotate when the newest transcript entry isn't the one they intended
 * (e.g., after `/rewind`).
 */

import React from "react";
import {
  getMessagePickerCount,
  setMessagePickerCount,
  MESSAGE_PICKER_COUNT_OPTIONS,
  type MessagePickerCount,
} from "../../utils/storage";

export interface PickerMessage {
  messageId: string;
  text: string;
  timestamp?: string;
  /** Optional host-provided title for a concise picker row. */
  label?: string;
  /** Optional host-provided secondary detail for a picker row. */
  description?: string;
  /** Pi assistant message identity; absent for a live pane awaiting its first response. */
  assistantMessageId?: string;
  /** Optional host grouping identity, distinct from assistant messageId. */
  paneId?: string;
  /** Optional host-provided Pi session identity for pane-scoped live drafts. */
  piSessionId?: string;
  /** Optional host-provided pane heading for grouped message pickers. */
  paneLabel?: string;
  /** Optional host-provided pane detail for grouped message pickers. */
  paneDescription?: string;
  /** Optional host-provided authoritative live agent state. */
  agentStatus?: 'working' | 'idle' | 'blocked' | 'unknown';
  /** Optional host-provided workspace root for the pane containing this response. */
  cwd?: string;
  /** Optional host-provided workspace identity for exact matching. */
  workspaceId?: string;
  /** Canonical live workspace identity supplied by the Herdr host. */
  workspaceKey?: string;
  /** Slash commands explicitly advertised by this live pane's current Pi session. */
  commands?: Array<{ name: string; description?: string; source: 'extension' | 'prompt' | 'skill'; arguments?: string[] }>;
  /** Pi-reported active context usage; null tokens are intentionally unknown. */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  /** Current model selected in the Pi session. */
  model?: { id: string; provider?: string; name?: string };
  /** Current tool or subagent activity reported by the Pi extension. */
  activity?: { kind: 'tool' | 'subagent'; name?: string; count: number };
  /** Cumulative model tokens charged over the complete Pi session. */
  totalUsedTokens?: number;
  /** Context tokens represented by the latest Pi compaction summary. */
  latestCompactionTokens?: number;
  /** Git branch resolved from this live pane's working directory. */
  gitBranch?: string;
  /** Managed Ex AI companion panes are visible but cannot create another companion. */
  isExAICompanion?: boolean;
}

interface MessagesBrowserProps {
  messages: PickerMessage[];
  selectedMessageId: string | null;
  onSelect: (messageId: string) => void;
  annotationCounts?: Map<string, number>;
  listLabel?: string;
  emptyLabel?: string;
  /** Ex-Plannotator's live compact history is chronological; normal hosts are newest-first. */
  chronological?: boolean;
}

// Hard cap for browsers where line-clamp is unavailable, and to avoid huge sidebar text nodes.
const PREVIEW_MAX_CHARS = 140;

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS).trimEnd() + "…"
    : normalized;
}

function formatTimestamp(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function resolveVisibleCount(count: MessagePickerCount): number {
  return count === "all" ? Number.POSITIVE_INFINITY : Number(count);
}

/** Original-list position retained so `#N` numbering and the ★ default marker
 * stay stable even after rows are clustered into herd sections. */
interface IndexedMessage {
  msg: PickerMessage;
  index: number;
}

interface HerdGroup {
  key: string;
  label: string;
  entries: IndexedMessage[];
}

/** Cluster rows by their live herd/workspace, preserving first-seen order so the
 * section list matches the order panes appear in the source snapshot. */
function groupByHerd(entries: IndexedMessage[]): HerdGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, HerdGroup>();
  for (const entry of entries) {
    const { msg } = entry;
    const key = msg.workspaceKey ?? msg.workspaceId ?? msg.paneLabel ?? msg.paneId ?? "ungrouped";
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: msg.paneLabel ?? "Workspace", entries: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.entries.push(entry);
  }
  return order.map((key) => byKey.get(key)!);
}

export const MessagesBrowser: React.FC<MessagesBrowserProps> = ({
  messages,
  selectedMessageId,
  onSelect,
  annotationCounts,
  listLabel = "Recent messages — newest first",
  emptyLabel = "No recent assistant messages found.",
  chronological = false,
}) => {
  const [count, setCount] = React.useState<MessagePickerCount>(() => getMessagePickerCount());
  // Whether the user expanded the flat list past the count cap this session.
  const [expanded, setExpanded] = React.useState(false);

  const handleCountChange = React.useCallback((next: MessagePickerCount) => {
    setCount(next);
    setMessagePickerCount(next);
    setExpanded(false);
  }, []);

  if (messages.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        {emptyLabel}
      </div>
    );
  }

  // Rows carry pane identity when the host is a live/grouped picker (Herdr).
  // In that mode we cluster rows under herd/workspace section headers instead
  // of repeating the workspace name inline on every row.
  const groupedByPane = messages.some((message) => message.paneId !== undefined);
  const visibleCount = resolveVisibleCount(count);

  const renderRow = (msg: PickerMessage, idx: number) => {
    const isSelected = msg.messageId === selectedMessageId;
    const isDefault = idx === 0;
    const ts = formatTimestamp(msg.timestamp);
    const annotationCount = annotationCounts?.get(msg.messageId) ?? 0;
    return (
      <button
        key={msg.messageId}
        onClick={() => onSelect(msg.messageId)}
        aria-current={isSelected ? "true" : undefined}
        aria-pressed={isSelected}
        className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-start gap-2 ${
          isSelected
            ? "bg-primary/10 text-primary border border-primary/30"
            : "text-foreground hover:bg-muted/50 border border-transparent"
        }`}
      >
        <span className="font-mono text-[10px] text-muted-foreground pt-0.5 w-8 shrink-0 text-right">
          #{idx + 1}
          {isDefault ? " \u2605" : ""}
        </span>
        <span className="flex-1 min-w-0">
          {groupedByPane && msg.isExAICompanion && (
            <span className="flex items-center gap-1 mb-0.5">
              <span className="inline-flex rounded border border-primary/30 bg-primary/10 px-1 text-[9px] text-primary">
                Ex AI
              </span>
            </span>
          )}
          <span className="line-clamp-2 leading-snug">
            {msg.label ?? previewText(msg.text)}
          </span>
          {(msg.description || ts) && (
            <span className="block text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
              {[msg.description, ts].filter(Boolean).join(' \u00b7 ')}
            </span>
          )}
        </span>
        {annotationCount > 0 && (
          <span
            className="shrink-0 min-w-5 h-5 px-1 rounded-full bg-primary/10 text-primary border border-primary/30 text-[10px] font-semibold inline-flex items-center justify-center"
            title={`${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`}
          >
            {annotationCount}
          </span>
        )}
      </button>
    );
  };

  // Grouped: the count caps responses PER herd (so "Show 1" leaves one latest
  // response per pane, not one row for the whole list). Flat: the count caps the
  // single global list as before. `index` stays global so `#N` numbering and the
  // ★ default marker are stable regardless of per-herd trimming.
  const indexedAll: IndexedMessage[] = messages.map((msg, index) => ({ msg, index }));
  let hiddenCount = 0;
  const herdGroups = groupedByPane
    ? groupByHerd(indexedAll).map((group) => {
        const entries = expanded ? group.entries : group.entries.slice(0, visibleCount);
        hiddenCount += group.entries.length - entries.length;
        return { ...group, entries };
      })
    : null;
  const flatShown = herdGroups ? null : indexedAll.slice(0, expanded ? indexedAll.length : visibleCount);
  if (flatShown) hiddenCount = messages.length - flatShown.length;

  return (
    <div className="p-2">
      <div className="px-2 pt-1 pb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          {chronological ? "Recent responses — oldest first" : listLabel}
        </span>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
          <span className="sr-only">Messages to show</span>
          <span aria-hidden="true">Show</span>
          <select
            value={count}
            onChange={(event) => handleCountChange(event.target.value as MessagePickerCount)}
            aria-label="Number of recent responses to show"
            className="rounded border border-border bg-transparent px-1 py-0.5 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          >
            {MESSAGE_PICKER_COUNT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="space-y-0.5">
        {herdGroups
          ? herdGroups.map((group) => (
              <div key={group.key} className="space-y-0.5">
                <div className="px-2 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                  {group.label}
                </div>
                {group.entries.map(({ msg, index }) => renderRow(msg, index))}
              </div>
            ))
          : flatShown!.map(({ msg, index }) => renderRow(msg, index))}
        {(hiddenCount > 0 || expanded) && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="w-full text-left px-2 py-1 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            {expanded ? "Show fewer" : `Show ${hiddenCount} older`}
          </button>
        )}
      </div>
    </div>
  );
};
