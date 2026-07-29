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
  /** Stable newest-first rows for the active session only: owns transcript scroll. */
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

/** `workspace · tab`, with the tab carrying the weight — panes in one workspace
 * share the prefix, so the tab is what actually tells them apart. */
const SessionIdentity = ({ workspace, tab, fallback }: { workspace: string; tab: string; fallback: string }) =>
  workspace && tab ? (
    <>
      <span className="text-muted-foreground">{workspace}</span>
      <span className="text-muted-foreground/50">{' · '}</span>
      <span className="font-semibold">{tab}</span>
    </>
  ) : (
    <span className="font-semibold">{fallback}</span>
  );

const identityParts = (session: Pick<SessionRowModel, 'workspace' | 'tab' | 'label'>) => {
  const workspace = sanitizeLabel(session.workspace);
  const tab = sanitizeLabel(session.tab);
  const fallback = sanitizeLabel(session.label) || 'Pane';
  return { workspace, tab, fallback, title: workspace && tab ? `${workspace} · ${tab}` : fallback };
};

/** Small tinted count. The panel's ONE tinted signal, so it always means unread. */
const UnreadBadge = ({ count, scope }: { count: number; scope: string }) => (
  <span
    aria-label={`${count} unread repl${count === 1 ? 'y' : 'ies'}${scope}`}
    className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground"
  >
    {count}
  </span>
);

/**
 * One scannable line of pane identity plus one line of what it last said.
 *
 * Selection is a SHAPE (the left rail) rather than another tint: the unread
 * badge and the activity glyph already compete for `primary`, and three
 * primary-coloured signals on one row read as none.
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
  const { workspace, tab, fallback, title } = identityParts(session);
  const age = sessionAge(session.timestamp);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      // Roving tabindex: the list is one tab stop, then Arrow/Home/End move
      // within it, rather than a tab stop per live pane.
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
        <span className="min-w-0 flex-1 truncate text-xs" title={title}>
          <SessionIdentity workspace={workspace} tab={tab} fallback={fallback} />
        </span>
        {age && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{age}</span>}
        {unread > 0 && <UnreadBadge count={unread} scope="" />}
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
  autoFocusActive = false,
}: {
  sessions: SessionRowModel[];
  activeSessionKey: LiveSessionKey | null;
  unreadCountBySession: Readonly<Record<string, readonly string[]>>;
  onActivateSession: (key: LiveSessionKey) => void;
  onAfterActivate?: () => void;
  /** Put the keyboard on the current pane the moment the picker opens. */
  autoFocusActive?: boolean;
}) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // The active session must be visible in its own picker: with several panes in
  // a short scroller it could otherwise sit entirely below the fold, so the
  // panel showed a session the list never displayed.
  React.useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    option?.scrollIntoView({ block: 'nearest' });
  }, [activeSessionKey]);

  React.useEffect(() => {
    if (!autoFocusActive) return;
    listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
  }, [autoFocusActive]);

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
 * takeover, so a handful of sessions no longer occupy a mostly-empty page. */
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
 *
 * The panel is ONE pane at a time: the header names the pane you are on and is
 * itself the switcher, so the pane list is a toggle rather than a permanent
 * band. That toggle is anchored LEFT, leading with its disclosure chevron.
 * Closed — which is the default, and where a captain reading one agent spends
 * nearly all their time — the response history owns the whole panel.
 *
 * The transcript is NEWEST-FIRST in real DOM order, so the response the captain
 * came for is the first thing they read and the first thing they tab to,
 * instead of the last row of a chat log they have to scroll to the end of.
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
  const [sessionListOpen, setSessionListOpen] = React.useState(false);
  const [mobileSessionsOpen, setMobileSessionsOpen] = React.useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = React.useState(false);
  const isMobile = useIsMobile(1024);
  const historyRegionId = React.useId();
  const sessionListId = React.useId();
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
    // be an older selected annotation target. The row preview must always be
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

  // Unread waiting in the panes you are NOT reading — the only reason to open
  // the switcher without being asked to, so it rides on the switcher itself.
  const unreadElsewhere = React.useMemo(
    () => sessions.reduce(
      (total, session) => session.sessionKey === activeSessionKey
        ? total
        : total + (unreadCountBySession[session.sessionKey]?.length ?? 0),
      0,
    ),
    [sessions, activeSessionKey, unreadCountBySession],
  );

  const selectedMessage = React.useMemo(
    () => activeTimelineMessages.find((message) => message.messageId === selectedMessageId)
      // Newest-first: the fallback default target is the head of the transcript.
      ?? activeTimelineMessages[0]
      ?? null,
    [activeTimelineMessages, selectedMessageId],
  );

  // The inline picker is transient: Escape dismisses it like the sheets do.
  React.useEffect(() => {
    if (!sessionListOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setSessionListOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sessionListOpen]);

  if (!active) return null;

  const { workspace, tab, fallback, title } = identityParts(active);
  const activeIdentity = <SessionIdentity workspace={workspace} tab={tab} fallback={fallback} />;
  // A single pane has nothing to switch to, so it gets no switcher at all.
  const canSwitch = sessions.length > 1;
  const switcherLabel = `Switch live pane — currently ${title}, ${sessions.length} panes`;
  const openSwitcher = () => (isMobile ? setMobileSessionsOpen(true) : setSessionListOpen(!sessionListOpen));
  const switcherExpanded = isMobile ? mobileSessionsOpen : sessionListOpen;

  return (
    <section
      data-live-session-timeline="true"
      className="flex min-h-0 w-full flex-1 flex-col rounded-xl border border-border/60 bg-card shadow-sm h-full"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 lg:px-4">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Agent Response</p>
          {canSwitch ? (
            <button
              type="button"
              data-live-session-switcher="true"
              onClick={openSwitcher}
              aria-label={switcherLabel}
              aria-haspopup={isMobile ? 'dialog' : 'listbox'}
              aria-expanded={switcherExpanded}
              aria-controls={isMobile ? undefined : sessionListId}
              title={switcherLabel}
              /* The toggle sits on the LEFT: its disclosure chevron LEADS at the
                 panel's left edge and the control hugs its own content, instead
                 of a full-width label bar with a stray arrow parked on the far
                 right. `min-h-8` keeps it a real touch target on mobile, where
                 the same control opens the sheet. */
              className="-ml-1 flex min-h-8 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${switcherExpanded ? '' : '-rotate-90'}`}
              >
                <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="min-w-0 truncate">{activeIdentity}</span>
              {unreadElsewhere > 0 && <UnreadBadge count={unreadElsewhere} scope=" in other panes" />}
            </button>
          ) : (
            <p className="truncate text-sm" title={title}>{activeIdentity}</p>
          )}
        </div>
        {activeTimelineMessages.length > 1 && (
          <button
            type="button"
            onClick={() => setMobileHistoryOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={mobileHistoryOpen}
            className="shrink-0 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            History
          </button>
        )}
      </header>
      {/* Toggled, not permanent: a band that is always mounted spends the
          panel's height on switching even for a captain who never switches.
          Closed, the response history below owns the whole panel. */}
      {canSwitch && sessionListOpen && !isMobile && (
        <div id={sessionListId} className="hidden min-h-0 shrink-0 border-b border-border/60 lg:block">
          <OverlayScrollArea className="max-h-56" style={{ overscrollBehaviorY: 'contain' }}>
            <SessionList
              sessions={sessions}
              activeSessionKey={activeSessionKey}
              unreadCountBySession={unreadCountBySession}
              onActivateSession={onActivateSession}
              onAfterActivate={() => setSessionListOpen(false)}
              autoFocusActive
            />
          </OverlayScrollArea>
        </div>
      )}
      {isMobile ? (
        <div data-live-timeline-selected-response="true" className="p-2">
          {selectedMessage ? (
            <MessagesBrowser
              messages={[selectedMessage]}
              selectedMessageId={selectedMessage.messageId}
              onSelect={onSelectMessage}
              annotationCounts={annotationCounts}
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
          aria-label="Response history — newest first"
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
            chatLayout
            autoLoadOnScroll
            listLabel="Session responses — newest first"
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
            aria-label="Response history — newest first"
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
              chatLayout
              autoLoadOnScroll={false}
              listLabel="Session responses — newest first"
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
