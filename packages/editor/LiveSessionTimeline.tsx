import React from 'react';
import { MessagesBrowser, type CaptainEcho, type PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { useIsMobile } from '@plannotator/ui/hooks/useIsMobile';
import { deriveLivePaneChips, type LivePaneChip } from './livePaneChips';
import { sessionAge, sessionPreview } from './live/sessionRowPreview';
import { type LiveSessionKey } from './live/liveSessionTimeline';

export type LiveSessionTimelineProps = {
  /** Stable newest-first snapshot rows: owns switcher cards and telemetry identity. */
  messages: PickerMessage[];
  /** Stable oldest-first rows for the active session only: owns transcript scroll. */
  activeTimelineMessages: PickerMessage[];
  activeSessionKey: LiveSessionKey | null;
  selectedMessageId: string | null;
  unreadCountBySession: Readonly<Record<string, readonly string[]>>;
  newReplyCount: number;
  annotationCounts: Map<string, number>;
  captainEchoes: ReadonlyMap<string, readonly CaptainEcho[]>;
  reviewRoundStatus?: string | null;
  contextHandoffHighPercent?: number;
  onActivateSession: (key: LiveSessionKey) => void;
  onSelectMessage: (messageId: string) => void;
  onJumpToNewReplies: () => void;
  jumpToLatestSignal: number;
};

const sessionKeyFor = (message: Pick<PickerMessage, 'piSessionId' | 'paneId'>): LiveSessionKey | null =>
  message.piSessionId ? `pi:${message.piSessionId}` : message.paneId ? `pane:${message.paneId}` : null;

const sanitizeLabel = (label?: string | null): string => {
  if (!label) return "";
  let cleaned = label
    .replace(/\bResponse\s+\d+(\s+·\s+latest)?\b/ig, "")
    .replace(/\bAGENT\s*#?\d+(\s+·\s+latest)?\b/ig, "")
    .trim();
  cleaned = cleaned.replace(/^\s*·\s*/, "").replace(/\s*·\s*$/, "").replace(/\s+/g, " ");
  return cleaned;
};

const toneClass = (tone?: string): string =>
  tone === 'blocked' ? 'text-destructive'
    : tone === 'waiting' ? 'text-warning-foreground'
      : tone === 'active' ? 'text-primary'
        : 'text-muted-foreground/70';

/** A session as this panel renders it: chip telemetry plus its newest response. */
type SessionRowModel = LivePaneChip & {
  sessionKey: LiveSessionKey;
  preview: string;
  timestamp?: string;
};

/**
 * One scannable line of pane identity plus one line of what it last said.
 *
 * The row deliberately carries a single signal per meaning: selection is a
 * SHAPE (the left rail), unread is the only tinted badge, and recency is plain
 * text. Before this the selected border, the unread pill and the activity glyph
 * were all `primary`, so at a glance none of them read as anything.
 */
const SessionRow = ({
  session,
  unread,
  active,
  onSelect,
}: {
  session: SessionRowModel;
  unread: number;
  active: boolean;
  onSelect: () => void;
}) => {
  const activity = session.activity?.label;
  const workspace = sanitizeLabel(session.workspace);
  const tab = sanitizeLabel(session.tab);
  const fallback = sanitizeLabel(session.label) || 'Pane';
  const title = workspace && tab ? `${workspace} · ${tab}` : fallback;
  const age = sessionAge(session.timestamp);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      // Roving tabindex: the listbox is one stop, then Arrow/Home/End move
      // within it. Tabbing through every live pane to reach the document was
      // the previous behavior.
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      className={`relative w-full rounded-md border py-1.5 pl-3 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? 'border-primary/50 bg-primary/10 text-foreground'
          : 'border-transparent hover:bg-muted/50 text-foreground'
      }`}
    >
      {active && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />}
      <span className="flex min-w-0 items-center gap-1.5">
        {session.activity && (
          <span aria-hidden="true" className={`shrink-0 ${toneClass(session.activity.tone)}`}>
            {session.activity.glyph}
          </span>
        )}
        {/* Workspace is de-emphasised and the tab carries the weight: panes in
            one workspace share the prefix, so the tab is the differentiator. */}
        <span className="min-w-0 flex-1 truncate text-xs" title={title}>
          {workspace && tab ? (
            <>
              <span className="text-muted-foreground">{workspace}</span>
              <span className="text-muted-foreground/50">{' · '}</span>
              <span className="font-semibold">{tab}</span>
            </>
          ) : (
            <span className="font-semibold">{fallback}</span>
          )}
        </span>
        {age && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{age}</span>}
        {unread > 0 && (
          <span
            aria-label={`${unread} unread repl${unread === 1 ? 'y' : 'ies'}`}
            className="ml-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground"
          >
            {unread}
          </span>
        )}
      </span>
      <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted-foreground">
        {session.preview}
      </span>
      {activity && <span className="sr-only">Activity: {activity}.</span>}
    </button>
  );
};

const SessionList = ({
  sessions,
  activeSessionKey,
  unreadCountBySession,
  onActivateSession,
  onAfterActivate,
}: {
  sessions: SessionRowModel[];
  activeSessionKey: LiveSessionKey | null;
  unreadCountBySession: Readonly<Record<string, readonly string[]>>;
  onActivateSession: (key: LiveSessionKey) => void;
  onAfterActivate?: () => void;
}) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // The active session must be visible in its own picker. With five panes in a
  // short scroller the active one could sit entirely below the fold on first
  // paint, so the panel showed a session the list never displayed.
  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeSessionKey]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (options.length === 0) return;
    const focused = options.findIndex((option) => option === document.activeElement);
    const from = focused === -1
      ? Math.max(0, options.findIndex((option) => option.getAttribute('aria-selected') === 'true'))
      : focused;
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(options.length - 1, from + 1)
          : Math.max(0, from - 1);
    event.preventDefault();
    options[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Live sessions"
      onKeyDown={onKeyDown}
      className="space-y-0.5 p-1.5"
    >
      {sessions.map((session) => (
        <SessionRow
          key={session.sessionKey}
          session={session}
          unread={unreadCountBySession[session.sessionKey]?.length ?? 0}
          active={activeSessionKey === session.sessionKey}
          onSelect={() => { onActivateSession(session.sessionKey); onAfterActivate?.(); }}
        />
      ))}
    </div>
  );
};

/**
 * Escape-to-close plus focus handoff for the mobile sheets. Without it the
 * sheets opened with focus still on `<body>` behind the overlay and Escape did
 * nothing, so a keyboard or screen-reader captain could not work them at all.
 */
function useSheetDismiss(open: boolean, onClose: () => void): React.RefObject<HTMLElement | null> {
  const ref = React.useRef<HTMLElement | null>(null);
  const closeRef = React.useRef(onClose);
  React.useEffect(() => { closeRef.current = onClose; }, [onClose]);
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);
  return ref;
}

/** Bottom sheet: bounded by its content up to 85dvh instead of a full-screen
 * takeover, so five sessions no longer occupy a mostly-empty 100dvh page. */
const MobileSheet = ({
  label,
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
}: {
  label: string;
  title: string;
  subtitle: React.ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  const sheetRef = useSheetDismiss(true, onClose);
  return (
    <div className="fixed inset-0 z-[80] flex items-end bg-black/50 lg:hidden" role="presentation" onClick={onClose}>
      <section
        ref={sheetRef as React.RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="flex max-h-[85dvh] w-full flex-col rounded-t-xl border-t border-border bg-card shadow-xl focus:outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {closeLabel}
          </button>
        </header>
        {children}
      </section>
    </div>
  );
};

const NewRepliesJump = ({ count, onJump }: { count: number; onJump: () => void }) => (
  <div className="sticky top-0 z-10 px-3 pt-2">
    <button
      type="button"
      onClick={onJump}
      className="w-full rounded-md border border-primary/35 bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {count} new repl{count === 1 ? 'y' : 'ies'} · Jump to new replies
    </button>
  </div>
);

/**
 * Live-only master/detail history owner. The host owns state and transport;
 * this component only projects its active session and provides explicit captain
 * actions. `MessagesBrowser` remains the shared transcript/paging/anchor seam.
 */
export const LiveSessionTimeline = React.memo(({
  messages,
  activeTimelineMessages,
  activeSessionKey,
  selectedMessageId,
  unreadCountBySession,
  newReplyCount,
  annotationCounts,
  captainEchoes,
  reviewRoundStatus,
  contextHandoffHighPercent,
  onActivateSession,
  onSelectMessage,
  onJumpToNewReplies,
  jumpToLatestSignal,
}: LiveSessionTimelineProps) => {
  const [mobileSessionsOpen, setMobileSessionsOpen] = React.useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = React.useState(false);
  const isMobile = useIsMobile(1024);
  const historyRegionId = React.useId();
  const closeSessions = React.useCallback(() => setMobileSessionsOpen(false), []);
  const closeHistory = React.useCallback(() => setMobileHistoryOpen(false), []);

  const { visible, overflow } = React.useMemo(
    () => deriveLivePaneChips(messages, {
      selectedMessageId,
      reviewRoundStatus,
      ctxWarnThreshold: contextHandoffHighPercent,
      maxVisible: Number.MAX_SAFE_INTEGER,
    }),
    [messages, selectedMessageId, reviewRoundStatus, contextHandoffHighPercent],
  );
  const sessions = React.useMemo<SessionRowModel[]>(() => [...visible, ...overflow].flatMap((chip) => {
    // The snapshot is newest-first, while chip derivation's representative may
    // be an older selected annotation target. The card preview must always be
    // the actual newest response in the session.
    const source = messages.find((message) => message.paneId === chip.paneId);
    const sessionKey = source ? sessionKeyFor(source) : null;
    if (!source || !sessionKey) return [];
    return [{
      ...chip,
      sessionKey,
      preview: sessionPreview(source.text || source.label || ''),
      timestamp: source.timestamp,
    }];
  }), [visible, overflow, messages]);
  const active = sessions.find((session) => session.sessionKey === activeSessionKey) ?? sessions[0];

  const selectedMessage = React.useMemo(
    () => activeTimelineMessages.find((message) => message.messageId === selectedMessageId)
      ?? activeTimelineMessages.at(-1)
      ?? null,
    [activeTimelineMessages, selectedMessageId],
  );

  if (!active) return null;

  const activeWorkspace = sanitizeLabel(active.workspace);
  const activeTab = sanitizeLabel(active.tab);
  const activeLabel = sanitizeLabel(active.label) || 'Pane';
  const activeIdentity = activeWorkspace && activeTab ? (
    <>
      <span>{activeWorkspace}</span>
      <span className="text-muted-foreground/60 mx-1.5">·</span>
      <span>{activeTab}</span>
    </>
  ) : (
    activeLabel
  );
  const activeIdentityTitle = activeWorkspace && activeTab ? `${activeWorkspace} · ${activeTab}` : activeLabel;

  return (
    <section
      data-live-session-timeline="true"
      className="flex min-h-0 w-full flex-1 flex-col rounded-xl border border-border/60 bg-card shadow-sm h-full"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 lg:px-4">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Agent Response</p>
          <p className="truncate text-sm font-semibold" title={activeIdentityTitle}>
            {activeIdentity}
          </p>
        </div>
        <div className="flex items-center gap-1.5 lg:hidden">
          {activeTimelineMessages.length > 1 && (
            <button
              type="button"
              onClick={() => setMobileHistoryOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={mobileHistoryOpen}
              className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              History
            </button>
          )}
          <button
            type="button"
            onClick={() => setMobileSessionsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={mobileSessionsOpen}
            className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            Sessions
          </button>
        </div>
      </header>
      {/* The switcher is capped well under the transcript's share of the panel.
          At 208px it took MORE of a 450px panel than the response it switches
          between; compact rows fit ~3 sessions in 144px and scroll for more. */}
      <div className="hidden min-h-0 shrink-0 border-b border-border/60 lg:block">
        <OverlayScrollArea className="max-h-36" style={{ overscrollBehaviorY: 'contain' }}>
          <SessionList
            sessions={sessions}
            activeSessionKey={activeSessionKey}
            unreadCountBySession={unreadCountBySession}
            onActivateSession={onActivateSession}
          />
        </OverlayScrollArea>
      </div>
      {isMobile ? (
        <div data-live-timeline-selected-response="true" className="p-2">
          {selectedMessage ? (
            <MessagesBrowser
              messages={[selectedMessage]}
              selectedMessageId={selectedMessage.messageId}
              onSelect={onSelectMessage}
              annotationCounts={annotationCounts}
              chronological
              chatLayout
              listLabel="Selected response"
              emptyLabel="No assistant response in this session yet."
              showCountControl={false}
              showListLabel={false}
            />
          ) : (
            <p className="p-2 text-xs text-muted-foreground">No assistant response in this session yet.</p>
          )}
        </div>
      ) : (
        <OverlayScrollArea
          id={historyRegionId}
          aria-label="Response history"
          className="min-h-0 flex-1"
          data-live-timeline-scroll="true"
          tabIndex={0}
          style={{ overscrollBehaviorY: 'contain' }}
        >
          {newReplyCount > 0 && <NewRepliesJump count={newReplyCount} onJump={onJumpToNewReplies} />}
          <MessagesBrowser
            messages={activeTimelineMessages}
            selectedMessageId={selectedMessageId}
            onSelect={onSelectMessage}
            annotationCounts={annotationCounts}
            captainEchoes={captainEchoes}
            chronological
            chatLayout
            autoLoadOnScroll
            listLabel="Session responses"
            emptyLabel="No assistant response in this session yet."
            jumpToLatestSignal={jumpToLatestSignal}
            showCountControl={false}
            showListLabel={false}
            pinLatestKey={activeSessionKey}
          />
        </OverlayScrollArea>
      )}
      {mobileSessionsOpen && (
        <MobileSheet
          label="Choose live session"
          title="Live sessions"
          subtitle="Choose a pane without leaving this response."
          closeLabel="Done"
          onClose={closeSessions}
        >
          <OverlayScrollArea className="min-h-0 flex-1" style={{ overscrollBehaviorY: 'contain' }}>
            <SessionList
              sessions={sessions}
              activeSessionKey={activeSessionKey}
              unreadCountBySession={unreadCountBySession}
              onActivateSession={onActivateSession}
              onAfterActivate={closeSessions}
            />
          </OverlayScrollArea>
        </MobileSheet>
      )}
      {mobileHistoryOpen && (
        <MobileSheet
          label="Response history"
          title="Response history"
          subtitle={activeIdentity}
          closeLabel="Close"
          onClose={closeHistory}
        >
          <OverlayScrollArea
            id={historyRegionId}
            aria-label="Response history"
            className="min-h-0 flex-1"
            data-live-timeline-scroll="true"
            tabIndex={0}
            style={{ overscrollBehaviorY: 'contain' }}
          >
            {newReplyCount > 0 && <NewRepliesJump count={newReplyCount} onJump={onJumpToNewReplies} />}
            <MessagesBrowser
              messages={activeTimelineMessages}
              selectedMessageId={selectedMessageId}
              onSelect={onSelectMessage}
              annotationCounts={annotationCounts}
              captainEchoes={captainEchoes}
              chronological
              chatLayout
              autoLoadOnScroll={false}
              listLabel="Session responses"
              emptyLabel="No assistant response in this session yet."
              jumpToLatestSignal={jumpToLatestSignal}
              rowBudgetOverride={activeTimelineMessages.length}
              showCountControl={false}
              showListLabel={false}
              pinLatestKey={activeSessionKey}
            />
          </OverlayScrollArea>
        </MobileSheet>
      )}
    </section>
  );
});

LiveSessionTimeline.displayName = 'LiveSessionTimeline';
