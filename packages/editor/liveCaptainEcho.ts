/**
 * Browser-local echo of the captain's own sent messages for the Ex-Plannotator
 * live pane.
 *
 * Why this exists: the live message list is built purely from assistant
 * enrichment, so the captain's own prompts never appear anywhere. The pending
 * instruction is deliberately deleted when Pi claims it
 * (`apps/herdr-process-service/server.ts` claim is destructive for at-most-once
 * delivery), and `apps/ex-pi-extension/assistant-message.ts` filters to
 * `role === "assistant"`. Both stay exactly as they are.
 *
 * So the two-sided transcript is reconstructed *client side only*:
 *  - nothing is published to the host, no `role` is added to the wire format;
 *  - entries live in `sessionStorage` (survive a reload of this browser
 *    session, die with the tab) rather than `localStorage`, because prompt text
 *    can carry credentials and commercial context and must not sit on disk;
 *  - entries are keyed `live:<paneId>:<piSessionId>`, the same scope the
 *    global-comment draft already uses (`App.tsx` globalCommentDraftKey), so a
 *    Pi-session change discards them through the existing boundary in
 *    `liveMessageScope.ts` — one retention story, not two;
 *  - echo rows are navigation context only. They are never annotation or
 *    review targets, so the `assistantMessageId` identity contract that drafts
 *    depend on is untouched.
 */

/**
 * Per-pane retention bound for the local echo.
 *
 * SINGLE SOURCE OF TRUTH FOR THIS LANE — re-point here.
 * The `plannotator-live-messages-window` lane owns the shared per-pane
 * retention constant (target 20). When that constant lands, delete the literal
 * below and re-export it from that module; this is the only place the bound is
 * defined, so the swap is a one-line change.
 */
export const LIVE_CAPTAIN_ECHO_RETENTION = 20;

/** `sessionStorage` key prefix. Shares the `live:<pane>:<session>` scope shape used for drafts. */
const STORAGE_PREFIX = 'plannotator-live-captain-echo:';

export type CaptainEchoEntry = {
  /** Opaque row identity. Never a Pi message id and never an annotation target. */
  id: string;
  text: string;
  /** ISO timestamp of the moment this browser sent the message. */
  timestamp: string;
};

/** Map of `live:<paneId>:<piSessionId>` -> newest-first echo entries. */
export type CaptainEchoStore = Record<string, CaptainEchoEntry[]>;

/** The pane+session scope key. Identical shape to the global-comment draft key. */
export function captainEchoScopeKey(paneId: string, piSessionId: string): string {
  return `live:${paneId}:${piSessionId}`;
}

/**
 * Appends a sent message to its pane+session scope, newest first, trimmed to
 * {@link LIVE_CAPTAIN_ECHO_RETENTION}. Blank text is ignored. Pure: callers own persistence.
 */
export function appendCaptainEcho(
  store: CaptainEchoStore,
  scopeKey: string,
  entry: CaptainEchoEntry,
): CaptainEchoStore {
  if (!entry.text.trim()) return store;
  const existing = store[scopeKey] ?? [];
  return {
    ...store,
    [scopeKey]: [entry, ...existing].slice(0, LIVE_CAPTAIN_ECHO_RETENTION),
  };
}

/**
 * Drops every echo scope belonging to `paneIds`. Called from the existing
 * "Pi session changed" boundary so the echo dies with the drafts.
 */
export function discardCaptainEchoesForPanes(
  store: CaptainEchoStore,
  paneIds: ReadonlySet<string>,
): CaptainEchoStore {
  if (paneIds.size === 0) return store;
  const next: CaptainEchoStore = {};
  for (const [key, entries] of Object.entries(store)) {
    if (!paneIds.has(paneScopeOf(key) ?? '')) next[key] = entries;
  }
  return next;
}

/** Extracts `<paneId>` from a `live:<paneId>:<piSessionId>` scope key. */
function paneScopeOf(scopeKey: string): string | null {
  const match = /^live:(.*):([^:]*)$/.exec(scopeKey);
  return match ? match[1] : null;
}

type ScopedMessage = { messageId: string; paneId?: string; piSessionId?: string };

/**
 * Anchors each pane+session's echo entries to the snapshot row they should
 * render above, returning `messageId -> newest-first entries`.
 *
 * The anchor is the pane's *first* row in the published list. The host emits
 * assistant responses newest-first per pane, so a message the captain just sent
 * belongs directly above that pane's newest response. The snapshot list itself
 * is never modified: echoes stay a render-time overlay, so they cannot shift row
 * numbering, cannot be selected, and cannot become annotation targets.
 */
export function buildCaptainEchoAnchors(
  messages: readonly ScopedMessage[],
  store: CaptainEchoStore,
): Map<string, CaptainEchoEntry[]> {
  const anchors = new Map<string, CaptainEchoEntry[]>();
  if (Object.keys(store).length === 0) return anchors;
  const anchored = new Set<string>();
  for (const message of messages) {
    if (!message.paneId || !message.piSessionId) continue;
    const scopeKey = captainEchoScopeKey(message.paneId, message.piSessionId);
    if (anchored.has(scopeKey)) continue;
    anchored.add(scopeKey);
    const entries = store[scopeKey];
    if (entries && entries.length > 0) anchors.set(message.messageId, entries);
  }
  return anchors;
}

/**
 * Removes scopes whose pane is no longer live, so a long-lived tab cannot
 * accumulate prompt text for panes that are gone.
 *
 * Deliberately keyed on pane only, not pane+session: a pane's `piSessionId`
 * arrives with enrichment, so matching the full scope here would delete echoes
 * restored from sessionStorage during the window before the first enriched
 * snapshot lands. A *changed* session is already handled by
 * {@link discardCaptainEchoesForPanes} at the existing boundary, which is the
 * single place that retention decision belongs.
 */
export function pruneCaptainEchoes(
  store: CaptainEchoStore,
  messages: readonly ScopedMessage[],
): CaptainEchoStore {
  if (messages.length === 0) return store;
  const livePanes = new Set<string>();
  for (const message of messages) {
    if (message.paneId) livePanes.add(message.paneId);
  }
  const next: CaptainEchoStore = {};
  for (const [key, entries] of Object.entries(store)) {
    const paneId = paneScopeOf(key);
    if (paneId && livePanes.has(paneId)) next[key] = entries;
  }
  return next;
}

// --- sessionStorage persistence -------------------------------------------------
// Deliberately sessionStorage, never localStorage: the echo must not outlive the
// tab. Every access is guarded because the editor also renders without a DOM.

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // Storage can throw when blocked by browser policy.
  }
}

/** Reads every persisted echo scope for this browser session. Never throws. */
export function loadCaptainEchoes(): CaptainEchoStore {
  const storage = sessionStore();
  if (!storage) return {};
  const store: CaptainEchoStore = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? 'null') as CaptainEchoEntry[] | null;
      if (!Array.isArray(parsed)) continue;
      const entries = parsed.filter(
        (entry): entry is CaptainEchoEntry =>
          !!entry && typeof entry.id === 'string' && typeof entry.text === 'string' && typeof entry.timestamp === 'string',
      );
      if (entries.length > 0) store[key.slice(STORAGE_PREFIX.length)] = entries.slice(0, LIVE_CAPTAIN_ECHO_RETENTION);
    } catch {
      // A corrupt entry is dropped rather than breaking the transcript.
    }
  }
  return store;
}

/** Mirrors `store` into sessionStorage, deleting scopes it no longer contains. Never throws. */
export function saveCaptainEchoes(store: CaptainEchoStore): void {
  const storage = sessionStore();
  if (!storage) return;
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) && !(key.slice(STORAGE_PREFIX.length) in store)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
    for (const [scopeKey, entries] of Object.entries(store)) {
      storage.setItem(`${STORAGE_PREFIX}${scopeKey}`, JSON.stringify(entries));
    }
  } catch {
    // Quota or policy failure must never block sending a message.
  }
}
