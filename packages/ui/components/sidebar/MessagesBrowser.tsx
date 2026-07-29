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
import { CaptainEchoRow } from "./CaptainEchoRow";

/**
 * A captain-authored message this browser sent, echoed back for a two-sided
 * transcript. Browser-local only: the host never stores captain turns, so these
 * are not snapshot rows, carry no Pi identity, and are never annotation targets.
 */
export interface CaptainEcho {
  id: string;
  text: string;
  timestamp?: string;
}

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
  /**
   * Optional host-provided Herdr tab name for this pane. Distinct from
   * {@link paneLabel} (workspace): panes in the same workspace share a
   * workspace label but have different tabs, so the live-pane header chips use
   * this to make each pane individually identifiable. Optional so non-live
   * surfaces are untouched.
   */
  paneTab?: string;
  /**
   * Herdr's agent kind for this pane (`pi`, `claude`, `codex`, `opencode`, or
   * anything a future Herdr reports). Resolved against
   * `@plannotator/core/live-pane-agents` to decide, per capability, what this
   * pane can actually do — so a pane that cannot do something says which one
   * and why instead of showing a dead affordance. Optional: non-live surfaces
   * never set it.
   */
  agent?: string;
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
  /**
   * Context-window handoff warning for this live pane. Present only when the
   * pane crossed the high-water threshold (see herdr context-handoff detector).
   * A WARNING affordance only: the captain fires the handoff manually.
   */
  contextHandoff?: {
    warn: boolean;
    percent: number | null;
    canManualHandoff: boolean;
    command?: string;
    crossingSeq: number;
  };
  /** Current model selected in the Pi session. */
  model?: { id: string; provider?: string; name?: string };
  /** Current tool or subagent activity reported by the Pi extension. */
  activity?: { kind: 'tool' | 'subagent'; name?: string; count: number };
  /**
   * Ordered names-only trail of tools/subagents used in the current turn,
   * oldest first. Names only — never any tool input/output payload. Bounded by
   * the extension so SSE frames stay small.
   */
  activityTrail?: Array<{
    kind: 'tool' | 'subagent';
    name?: string;
    count: number;
    /**
     * Optional redacted, single-line, hard-truncated command summary for
     * bash-like tools (e.g. `npm test`). Redaction + truncation are applied at
     * the source before it reaches the wire; never a full/raw command. Absent
     * for non-bash tools, which stay names-only.
     */
    command?: string;
  }>;
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
  /**
   * Ex-Plannotator's live pane renders a two-sided chat transcript: agent
   * responses as left-aligned bubbles, captain echoes as right-aligned bubbles.
   * Optional so every non-live surface keeps the compact list rows unchanged.
   * Annotation semantics are identical either way — only the agent response
   * rows are selectable buttons; echoes are never annotation targets.
   */
  chatLayout?: boolean;
  /**
   * Browser-local captain echoes to render above a snapshot row, keyed by that
   * row's `messageId`. Kept out of `messages` on purpose: echoes must not shift
   * `#N` numbering or consume the per-pane visible-count window, and they must
   * never become selectable annotation targets.
   */
  captainEchoes?: ReadonlyMap<string, readonly CaptainEcho[]>;
  /**
   * Opt-in infinite-scroll for browsing history in a bounded scroll region
   * (the live Messages tab). When enabled the row budget:
   *   1. auto-fills until the list overflows its scroller, so there is a real
   *      scroll region to drag/wheel/keyboard through instead of a 3-row stub
   *      that only grows via `+N more`; and
   *   2. pages in older rows as the reader scrolls toward the history edge
   *      (the top in a chronological transcript, the bottom otherwise).
   * The `+N more` button remains as a fallback. Optional and defaulted-off so
   * every other consumer (annotate-last picker, etc.) is unchanged, and it
   * composes with the existing `pagedRows` state so the SSE scroll-anchor and
   * `Jump to latest` guarantees are preserved.
   */
  autoLoadOnScroll?: boolean;
  /** Increment to explicitly jump this shared transcript to its latest row. */
  jumpToLatestSignal?: number;
  /**
   * Optional fixed row budget for an embedded, bounded history. It bypasses
   * the reader's saved per-pane picker preference without changing that
   * preference for other MessagesBrowser consumers.
   */
  rowBudgetOverride?: number;
  /** Hide the saved per-pane count selector for a host-owned history view. */
  showCountControl?: boolean;
  /**
   * Hide the list caption. A host that already names this list in its own
   * chrome (the live Agent Response panel header) would otherwise stack a
   * second, weaker label on top of it. Defaults to showing the caption so
   * every existing picker is unchanged.
   */
  showListLabel?: boolean;
  /**
   * Identity of the conversation being shown. Opening a transcript must land
   * on its NEWEST turn, and in a chronological (oldest-first) transcript that
   * is the bottom — whereas a fresh mount starts at scrollTop 0, i.e. the
   * OLDEST turn, clipping the response the reader came for.
   *
   * The jump fires on mount and whenever this key changes (the host switched
   * conversations), and deliberately NOT when `messages` changes: an incoming
   * live frame must never move the viewport under the reader. Omit the prop to
   * keep a caller's scroll position entirely untouched.
   */
  pinLatestKey?: string | null;
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

/** Rows revealed per `+N more` click, and per auto-load step when scrolling. */
export const MESSAGE_PAGE_STEP = 5;

/**
 * Distance (px) from the history edge at which auto-load pages in older rows,
 * and the slack allowed when deciding the list "overflows" its scroller. Large
 * enough that momentum/keyboard scrolling loads the next page before the reader
 * hits a hard stop, small enough not to page in eagerly on a barely-tall list.
 */
export const MESSAGE_AUTOLOAD_THRESHOLD_PX = 96;

/**
 * Whether the reader has scrolled close enough to the history edge that the
 * next page of older rows should load. History lives at the TOP of a
 * chronological transcript (newest pinned at the bottom) and at the BOTTOM of a
 * newest-first list, so the edge we watch flips with `chronological`.
 */
export function isNearHistoryEdge(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  chronological: boolean,
  threshold: number = MESSAGE_AUTOLOAD_THRESHOLD_PX,
): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  return chronological
    ? scrollTop <= threshold
    : scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * Per-pane row budget: the selected quota plus any rows the reader has paged
 * in. Paging composes with the quota instead of overriding it, so changing the
 * quota never discards paging progress and `All` stays absolute.
 */
export function resolveRowBudget(count: MessagePickerCount, pagedRows: number): number {
  const quota = resolveVisibleCount(count);
  return quota === Number.POSITIVE_INFINITY ? quota : quota + pagedRows;
}

/**
 * Scroll offset that keeps the reader's viewport visually still when a live
 * frame changes the list's height. Returns the new `scrollTop` to apply.
 *
 * Only growth above the viewport is compensated. A reader parked at the very
 * top (scrollTop 0) is intentionally left alone: that is the "following the
 * latest" position, and moving them would be the bug, not the fix.
 */
export function anchoredScrollTop(
  previous: { scrollTop: number; scrollHeight: number },
  nextScrollHeight: number,
): number {
  if (previous.scrollTop <= 0) return previous.scrollTop;
  const delta = nextScrollHeight - previous.scrollHeight;
  if (delta === 0) return previous.scrollTop;
  return Math.max(0, previous.scrollTop + delta);
}

/**
 * Which end of the list the rows that changed this frame entered at. Only
 * growth ABOVE the viewport may be compensated, and the ordering decides which
 * end that is — so flipping a transcript's order has to flip this with it.
 *
 *  - `live`: an incoming frame. It prepends above the viewport in a
 *    newest-first list, so {@link anchoredScrollTop} holds the reader still —
 *    while deliberately leaving a reader parked at scrollTop 0 alone, because
 *    that is the "following the latest" position.
 *  - `page-prepend`: `+N more` in an oldest-first transcript adds history above
 *    the viewport, so the reader is pushed down by exactly that much — from
 *    scrollTop 0 too, where they are sitting ON the history edge.
 *  - `page-append`: `+N more` in a newest-first list adds history BELOW the
 *    viewport. Nothing above it moved, so touching scrollTop would itself be
 *    the bug: the reader would be thrown down the list they just paged into.
 */
export type ListGrowthEdge = "live" | "page-prepend" | "page-append";

export function anchoredScrollTopForGrowth(
  previous: { scrollTop: number; scrollHeight: number },
  nextScrollHeight: number,
  edge: ListGrowthEdge,
): number {
  if (edge === "page-append") return previous.scrollTop;
  if (edge === "page-prepend") {
    return Math.max(0, previous.scrollTop + nextScrollHeight - previous.scrollHeight);
  }
  return anchoredScrollTop(previous, nextScrollHeight);
}

/**
 * Preferred anchor: how far a row the reader is actually looking at moved.
 *
 * Height arithmetic cannot describe a WINDOWED list. The row budget keeps a
 * fixed number of rows, so a prepended live turn also evicts one off the far
 * end: total height changes by nearly nothing while every visible row slides
 * down a full slot. Measuring one surviving row instead is exact, and stays
 * exact when rows differ in height.
 *
 * The two deliberate exemptions from the growth anchor survive unchanged: a
 * `page-append` never moves the reader, and a `live` frame leaves a reader
 * parked at the top alone, because that is the "following the latest" position
 * and pinning the old top row there would push the new turn out of sight.
 */
export function anchoredScrollTopForRowShift(
  current: { scrollTop: number },
  rowShift: number,
  edge: ListGrowthEdge,
): number {
  if (edge === "page-append") return current.scrollTop;
  if (edge === "live" && current.scrollTop <= 0) return current.scrollTop;
  return Math.max(0, current.scrollTop + rowShift);
}

/** The row the reader is looking at, and where it sits in the scroller. */
type RowAnchor = { messageId: string; offsetTop: number };

function messageRows(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>("[data-message-row]")) : [];
}

/** First row still visible at the scroller's top edge — what the reader's eye
 * is resting on, and therefore what must not move under them. */
function captureRowAnchor(root: HTMLElement | null, scroller: HTMLElement): RowAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  for (const row of messageRows(root)) {
    const box = row.getBoundingClientRect();
    const messageId = row.dataset.messageRow;
    if (messageId && box.bottom > top) return { messageId, offsetTop: box.top - top };
  }
  return null;
}

/** How far the anchored row moved this frame, or null when it no longer exists
 * (evicted by the budget), in which case the caller falls back to heights. */
function rowAnchorShift(root: HTMLElement | null, scroller: HTMLElement, anchor: RowAnchor | null): number | null {
  if (!anchor) return null;
  const row = messageRows(root).find((candidate) => candidate.dataset.messageRow === anchor.messageId);
  if (!row) return null;
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offsetTop;
}

/** Nearest scrollable ancestor, so anchoring works without owning the scroller. */
function scrollableAncestor(node: HTMLElement | null): HTMLElement | null {
  let element = node?.parentElement ?? null;
  while (element) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if (/(auto|scroll|overlay)/.test(overflowY)) return element;
    element = element.parentElement;
  }
  return null;
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

function sessionKey(message: PickerMessage): string {
  return message.piSessionId ?? message.paneId ?? "ungrouped";
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
  chatLayout = false,
  captainEchoes,
  autoLoadOnScroll = false,
  jumpToLatestSignal,
  rowBudgetOverride,
  showCountControl = true,
  showListLabel = true,
  pinLatestKey,
}) => {
  const [count, setCount] = React.useState<MessagePickerCount>(() => getMessagePickerCount());
  // Rows paged in past the per-pane quota. Additive, and deliberately NOT
  // reset when the quota changes: the reader's paging is their own state.
  const [pagedRows, setPagedRows] = React.useState(0);
  // Live count of rows still hidden below the current budget, mirrored into a
  // ref so the scroll listener and the auto-fill effect can read it without
  // re-subscribing on every render. Written during render, below.
  const hiddenCountRef = React.useRef(0);
  const pageEdgeRef = React.useRef<ListGrowthEdge | null>(null);
  const pagePendingRef = React.useRef(false);

  const pageOlder = React.useCallback(() => {
    if (pagePendingRef.current) return;
    pagePendingRef.current = true;
    // Older rows enter at the TOP of an oldest-first transcript and at the
    // BOTTOM of a newest-first one — see `anchoredScrollTopForGrowth`.
    pageEdgeRef.current = chronological ? "page-prepend" : "page-append";
    setPagedRows((prev) => prev + MESSAGE_PAGE_STEP);
  }, [chronological]);

  const handleCountChange = React.useCallback((next: MessagePickerCount) => {
    setCount(next);
    setMessagePickerCount(next);
  }, []);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const latestRowRef = React.useRef<HTMLButtonElement | null>(null);
  const scrollMetricsRef = React.useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const rowAnchorRef = React.useRef<RowAnchor | null>(null);
  const [isAwayFromLatest, setIsAwayFromLatest] = React.useState(false);

  // An arriving SSE frame must never move the viewport under the reader.
  // Height growth above the viewport is compensated before paint.
  React.useLayoutEffect(() => {
    const scroller = scrollableAncestor(rootRef.current);
    if (!scroller) return;
    const previous = scrollMetricsRef.current;
    const edge = pageEdgeRef.current ?? "live";
    if (previous) {
      const rowShift = rowAnchorShift(rootRef.current, scroller, rowAnchorRef.current);
      const next = rowShift === null
        ? anchoredScrollTopForGrowth(previous, scroller.scrollHeight, edge)
        : anchoredScrollTopForRowShift(scroller, rowShift, edge);
      if (next !== scroller.scrollTop) scroller.scrollTop = next;
    }
    pageEdgeRef.current = null;
    pagePendingRef.current = false;
    scrollMetricsRef.current = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
    rowAnchorRef.current = captureRowAnchor(rootRef.current, scroller);
  }, [messages, count, pagedRows]);

  // Fill a tall Messages panel until it has an actual scrollable history.
  // Declared after the anchor so each prepended page is compensated first.
  React.useLayoutEffect(() => {
    if (!autoLoadOnScroll || hiddenCountRef.current <= 0) return;
    const scroller = scrollableAncestor(rootRef.current);
    if (!scroller) return;
    const overflows =
      scroller.scrollHeight > scroller.clientHeight + MESSAGE_AUTOLOAD_THRESHOLD_PX;
    if (!overflows) pageOlder();
  }, [autoLoadOnScroll, messages, count, pagedRows, pageOlder]);

  // Land on the newest turn when this conversation is opened or swapped.
  // Declared last so it wins over the anchor on the frame the key changes, and
  // guarded on the key (not on `messages`) so an arriving live frame — which
  // re-runs this effect — leaves the reader exactly where they were. The pin is
  // only claimed once there are rows to pin to, so a key that changes ahead of
  // its content still lands correctly.
  const pinnedKeyRef = React.useRef<string | null | undefined>(undefined);
  React.useLayoutEffect(() => {
    if (pinLatestKey === undefined || pinnedKeyRef.current === pinLatestKey) return;
    if (messages.length === 0) return;
    const scroller = scrollableAncestor(rootRef.current);
    if (!scroller) return;
    pinnedKeyRef.current = pinLatestKey;
    scroller.scrollTop = chronological ? scroller.scrollHeight : 0;
    scrollMetricsRef.current = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
  }, [pinLatestKey, chronological, messages]);

  // Track whether the latest row has scrolled out of view, which is what makes
  // the explicit `Jump to latest` affordance necessary rather than decorative.
  React.useEffect(() => {
    const scroller = scrollableAncestor(rootRef.current);
    if (!scroller) return;
    const sync = () => {
      scrollMetricsRef.current = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
      // Re-anchor as the reader moves, so the row held still by the next live
      // frame is the one they are looking at now, not where they started.
      rowAnchorRef.current = captureRowAnchor(rootRef.current, scroller);
      const row = latestRowRef.current;
      if (!row) {
        setIsAwayFromLatest(false);
        return;
      }
      const rowBox = row.getBoundingClientRect();
      const scrollerBox = scroller.getBoundingClientRect();
      setIsAwayFromLatest(rowBox.bottom < scrollerBox.top || rowBox.top > scrollerBox.bottom);
    };
    const onScroll = () => {
      sync();
      if (
        autoLoadOnScroll &&
        hiddenCountRef.current > 0 &&
        isNearHistoryEdge(
          {
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
          },
          chronological,
        )
      ) {
        pageOlder();
      }
    };
    sync();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [messages, count, pagedRows, autoLoadOnScroll, chronological, pageOlder]);

  const jumpToLatest = React.useCallback(() => {
    latestRowRef.current?.scrollIntoView({
      block: chronological ? "end" : "start",
      behavior: "smooth",
    });
  }, [chronological]);
  const latestSignalRef = React.useRef(jumpToLatestSignal);
  React.useEffect(() => {
    if (jumpToLatestSignal !== undefined && latestSignalRef.current !== undefined && latestSignalRef.current !== jumpToLatestSignal) {
      jumpToLatest();
    }
    latestSignalRef.current = jumpToLatestSignal;
  }, [jumpToLatest, jumpToLatestSignal]);

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
  //
  // A chat transcript is exempt: `chatLayout` renders ONE conversation, so a
  // workspace section header there labels a group of one and just repeats the
  // panel header. Grouping and the flat path select identical rows for a
  // single session, so this only removes the redundant heading.
  const groupedByPane = !chatLayout && messages.some((message) => message.paneId !== undefined);
  // Per-pane budget = selected quota + rows the reader paged in.
  const rowBudget = rowBudgetOverride ?? resolveRowBudget(count, pagedRows);
  // The newest response: last row when the host is chronological (live panes),
  // first row otherwise. This is the scroll anchor and `Jump to latest` target.
  const latestIndex = chronological ? messages.length - 1 : 0;

  const renderRow = (msg: PickerMessage, idx: number) => {
    const isSelected = msg.messageId === selectedMessageId;
    // The ★ marks the default annotation target (the latest response): the last
    // row in a chronological transcript, the first row in a newest-first list.
    const isDefault = idx === latestIndex;
    const ts = formatTimestamp(msg.timestamp);
    const annotationCount = annotationCounts?.get(msg.messageId) ?? 0;

    const rawLabel = msg.label ?? "";
    const sanitizedLabel = rawLabel
      .replace(/\bResponse\s+\d+(\s+·\s+latest)?\b/ig, "")
      .replace(/\bAGENT\s*#?\d+(\s+·\s+latest)?\b/ig, "")
      .trim()
      .replace(/^\s*·\s*/, "")
      .replace(/\s*·\s*$/, "")
      .replace(/\s+/g, " ");

    const isAnonymousLabel = !sanitizedLabel ||
      /^Response\s+\d+(\s+·\s+latest)?$/i.test(rawLabel) ||
      /^AGENT\s*#?\d+(\s+·\s+latest)?$/i.test(rawLabel);

    const displayText = isAnonymousLabel ? previewText(msg.text ?? "") : sanitizedLabel;

    // Chat layout: the agent turn is a left-aligned bubble. It is STILL a
    // <button> and still the annotation target — only its shape changes, so the
    // picker and annotation semantics are untouched.
    if (chatLayout) {
      return (
        <div key={msg.messageId} className="flex w-full justify-start">
          <button
            ref={idx === latestIndex ? latestRowRef : undefined}
            data-message-row={msg.messageId}
            onClick={() => onSelect(msg.messageId)}
            aria-current={isSelected ? "true" : undefined}
            aria-pressed={isSelected}
            className={`max-w-[85%] text-left rounded-lg rounded-bl-sm px-2.5 py-1.5 text-xs transition-colors border ${
              isSelected
                ? "bg-primary/10 text-primary border-primary/40"
                : "bg-muted/40 text-foreground border-border/60 hover:bg-muted/70"
            }`}
          >
            <span className="block line-clamp-3 leading-snug whitespace-pre-wrap">
              {displayText}
            </span>
            {((ts) || annotationCount > 0 || isDefault) && (
              <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground mt-1">
                {ts && <span>{ts}</span>}
                {isDefault && <span className="text-primary font-semibold">★ Latest</span>}
                {annotationCount > 0 && (
                  <span
                    className="ml-auto min-w-4 h-4 px-1 rounded-full bg-primary/15 text-primary border border-primary/30 text-[9px] font-semibold inline-flex items-center justify-center"
                    title={`${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`}
                  >
                    {annotationCount}
                  </span>
                )}
              </span>
            )}
          </button>
        </div>
      );
    }
    return (
      <button
        key={msg.messageId}
        ref={idx === latestIndex ? latestRowRef : undefined}
        data-message-row={msg.messageId}
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
            {displayText}
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

  /**
   * Snapshot row plus any browser-local captain echoes anchored to it. Echoes
   * anchor to the NEWEST agent row of their pane. In the newest-first picker
   * that row sits at the top, so echoes render above it. In the chronological
   * chat transcript that row sits at the bottom and a captain echo is a prompt
   * sent AFTER the latest response, so echoes render below it instead — keeping
   * the two-sided transcript in true chronological order.
   */
  const renderEntry = ({ msg, index }: IndexedMessage) => {
    const echoes = captainEchoes?.get(msg.messageId);
    if (!echoes || echoes.length === 0) return renderRow(msg, index);
    // Echoes are stored newest-first. The newest-first picker renders them as
    // stored; the chronological transcript reverses to oldest-first so the
    // captain's latest prompt sits at the very bottom, next to the newest turn.
    const orderedEchoes = chronological ? [...echoes].reverse() : echoes;
    const echoRows = orderedEchoes.map((echo) => (
      <CaptainEchoRow key={echo.id} text={echo.text} timestamp={formatTimestamp(echo.timestamp)} variant={chatLayout ? "bubble" : "row"} />
    ));
    return (
      <React.Fragment key={`entry:${msg.messageId}`}>
        {!chronological && echoRows}
        {renderRow(msg, index)}
        {chronological && echoRows}
      </React.Fragment>
    );
  };

  // Grouped: herd/workspace remains a presentation boundary, while the count
  // applies independently to each Pi session. Flat callers keep one global list.
  // `index` stays global so `#N` numbering and the ★ marker remain stable.
  const indexedAll: IndexedMessage[] = messages.map((msg, index) => ({ msg, index }));
  let hiddenCount = 0;
  // The budget keeps the NEWEST rows. Newest-first callers keep the head; a
  // chronological (oldest-first) transcript keeps the tail so the latest turn
  // always stays visible and older turns are what `+N more` reveals.
  const withinBudget = (seen: number, total: number): boolean =>
    chronological ? seen >= total - rowBudget : seen < rowBudget;
  const herdGroups = groupedByPane
    ? groupByHerd(indexedAll).map((group) => {
        const totalsBySession = new Map<string, number>();
        for (const { msg } of group.entries) {
          const key = sessionKey(msg);
          totalsBySession.set(key, (totalsBySession.get(key) ?? 0) + 1);
        }
        const seenBySession = new Map<string, number>();
        const entries = group.entries.filter(({ msg }) => {
          const key = sessionKey(msg);
          const seen = seenBySession.get(key) ?? 0;
          seenBySession.set(key, seen + 1);
          return withinBudget(seen, totalsBySession.get(key) ?? 0);
        });
        hiddenCount += group.entries.length - entries.length;
        return { ...group, entries };
      })
    : null;
  const flatShown = herdGroups
    ? null
    : rowBudget === Number.POSITIVE_INFINITY
      ? indexedAll
      : chronological
        ? indexedAll.slice(Math.max(0, indexedAll.length - rowBudget))
        : indexedAll.slice(0, rowBudget);
  if (flatShown) hiddenCount = messages.length - flatShown.length;
  // Mirror the still-hidden count so the scroll listener and auto-fill effect
  // (which run after paint, off this render's closure) can decide whether more
  // history remains to page in without re-subscribing every render.
  hiddenCountRef.current = hiddenCount;

  return (
    <div className="p-2" ref={rootRef}>
      <div
        className={`px-2 flex items-center gap-2 ${showListLabel ? "justify-between" : "justify-end"} ${
          showListLabel || showCountControl ? "pt-1 pb-2" : ""
        }`}
      >
        {showListLabel && (
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            {chronological ? "Recent responses — oldest first" : listLabel}
          </span>
        )}
        {showCountControl && (
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
            <span className="sr-only">Responses to show per pane</span>
            <span aria-hidden="true">Per pane:</span>
            <select
              value={count}
              onChange={(event) => handleCountChange(event.target.value as MessagePickerCount)}
              aria-label="Responses to show per pane"
              className="rounded border border-border bg-transparent px-1 py-0.5 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
            >
              {MESSAGE_PICKER_COUNT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {/* One control, never two.

          These used to be a pair of full-width, identically-styled, primary
          tinted buttons reading "Jump to latest" and "Back to latest" — one
          word apart, stacked, and doing genuinely different things: the first
          only SCROLLS the list, the second CHANGES which response is open. They
          could render simultaneously, and nobody could tell which was which.

          Selecting is the stronger action and subsumes the scroll, so when the
          reader is on an older response that is the one offered; the pure
          scroll control only appears when the selection is already the newest
          and the list has merely been scrolled away from it. Both now say what
          they do rather than sharing a vague "latest". */}
      {selectedMessageId !== undefined && selectedMessageId !== null && messages[latestIndex] !== undefined && selectedMessageId !== messages[latestIndex].messageId ? (
        <button
          type="button"
          onClick={() => {
            const latestMsg = messages[latestIndex];
            if (latestMsg) {
              onSelect(latestMsg.messageId);
              setTimeout(() => {
                latestRowRef.current?.scrollIntoView({
                  block: chronological ? "end" : "start",
                  behavior: "smooth",
                });
              }, 50);
            }
          }}
          className="w-full mb-1 px-2 py-1 rounded text-[10px] font-medium text-primary border border-primary/30 bg-primary/10 hover:bg-primary/20 transition-colors"
        >
          Open newest response
        </button>
      ) : isAwayFromLatest ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="w-full mb-1 px-2 py-1 rounded text-[10px] font-medium text-primary border border-primary/30 bg-primary/10 hover:bg-primary/20 transition-colors"
        >
          Scroll to newest
        </button>
      ) : null}
      <div className="space-y-0.5">
        {herdGroups
          ? herdGroups.map((group) => (
              <div key={group.key} className="space-y-0.5">
                <div className="px-2 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                  {group.label}
                </div>
                {group.entries.map(renderEntry)}
              </div>
            ))
          : flatShown!.map(renderEntry)}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={pageOlder}
            className="w-full text-left px-2 py-1 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            +{Math.min(hiddenCount, MESSAGE_PAGE_STEP)} more
          </button>
        )}
        {pagedRows > 0 && (
          <button
            type="button"
            onClick={() => setPagedRows(0)}
            className="w-full text-left px-2 py-1 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            Show fewer
          </button>
        )}
      </div>
    </div>
  );
};
