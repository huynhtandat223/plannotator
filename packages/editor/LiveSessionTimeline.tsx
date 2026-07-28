import React from 'react';
import { MessagesBrowser, type CaptainEcho, type PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { useIsMobile } from '@plannotator/ui/hooks/useIsMobile';
import { deriveLivePaneChips, type LivePaneChip } from './livePaneChips';
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

const preview = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 96 ? `${normalized.slice(0, 96).trimEnd()}…` : normalized;
};

const sessionIdentity = (chip: LivePaneChip): string => chip.label;

const SessionCard = ({
  chip,
  sessionKey,
  unread,
  active,
  onSelect,
}: {
  chip: LivePaneChip & { preview: string };
  sessionKey: LiveSessionKey;
  unread: number;
  active: boolean;
  onSelect: () => void;
}) => {
  const activity = chip.activity?.label;
  const displayName = chip.workspace && chip.tab ? `${chip.workspace} · ${chip.tab}` : chip.label;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? 'border-primary/60 bg-primary/10 text-foreground'
          : 'border-border/70 bg-card hover:bg-muted/50 text-foreground'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {chip.activity && (
          <span
            aria-hidden="true"
            className={chip.activity.tone === 'blocked' ? 'text-destructive' : chip.activity.tone === 'waiting' ? 'text-warning-foreground' : chip.activity.tone === 'active' ? 'text-primary' : 'text-muted-foreground'}
          >
            {chip.activity.glyph}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={displayName}>
          {displayName}
        </span>
        {unread > 0 && (
          <span aria-label={`${unread} unread repl${unread === 1 ? 'y' : 'ies'}`} className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold tabular-nums text-primary-foreground">
            {unread}
          </span>
        )}
      </span>
      <span className="mt-1 block line-clamp-2 text-[11px] leading-snug text-muted-foreground">
        {preview(chip.preview)}
      </span>
      {activity && <span className="sr-only">Activity: {activity}.</span>}
    </button>
  );
};

const SessionList = ({
  chips,
  activeSessionKey,
  unreadCountBySession,
  onActivateSession,
  onAfterActivate,
}: {
  chips: Array<LivePaneChip & { sessionKey: LiveSessionKey; preview: string }>;
  activeSessionKey: LiveSessionKey | null;
  unreadCountBySession: Readonly<Record<string, readonly string[]>>;
  onActivateSession: (key: LiveSessionKey) => void;
  onAfterActivate?: () => void;
}) => (
  <div role="listbox" aria-label="Live sessions" className="space-y-2 p-3">
    {chips.map((chip) => (
      <SessionCard
        key={chip.sessionKey}
        chip={chip}
        sessionKey={chip.sessionKey}
        unread={unreadCountBySession[chip.sessionKey]?.length ?? 0}
        active={activeSessionKey === chip.sessionKey}
        onSelect={() => { onActivateSession(chip.sessionKey); onAfterActivate?.(); }}
      />
    ))}
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
  const isMobile = useIsMobile(1024);
  const [historyExpanded, setHistoryExpanded] = React.useState(false);

  const { visible, overflow } = React.useMemo(
    () => deriveLivePaneChips(messages, {
      selectedMessageId,
      reviewRoundStatus,
      ctxWarnThreshold: contextHandoffHighPercent,
      maxVisible: Number.MAX_SAFE_INTEGER,
    }),
    [messages, selectedMessageId, reviewRoundStatus, contextHandoffHighPercent],
  );
  const sessions = React.useMemo(() => [...visible, ...overflow].flatMap((chip) => {
    // The snapshot is newest-first, while chip derivation's representative may
    // be an older selected annotation target. The card preview must always be
    // the actual newest response in the session.
    const source = messages.find((message) => message.paneId === chip.paneId);
    const sessionKey = source ? sessionKeyFor(source) : null;
    return source && sessionKey ? [{ ...chip, sessionKey, preview: source.text || source.label || '' }] : [];
  }), [visible, overflow, messages]);
  const active = sessions.find((session) => session.sessionKey === activeSessionKey) ?? sessions[0];

  const filteredMessages = React.useMemo(() => {
    if (isMobile && !historyExpanded) {
      const selected = activeTimelineMessages.find((m) => m.messageId === selectedMessageId);
      if (selected) return [selected];
      if (activeTimelineMessages.length > 0) return [activeTimelineMessages[activeTimelineMessages.length - 1]];
      return [];
    }
    return activeTimelineMessages;
  }, [isMobile, historyExpanded, activeTimelineMessages, selectedMessageId]);

  const filteredEchoes = React.useMemo(() => {
    if (isMobile && !historyExpanded) {
      return new Map();
    }
    return captainEchoes;
  }, [isMobile, historyExpanded, captainEchoes]);

  if (!active) return null;

  return (
    <section
      data-live-session-timeline="true"
      className={`flex min-h-0 w-full flex-1 flex-col rounded-xl border border-border/60 bg-card shadow-sm ${
        isMobile ? (historyExpanded ? 'h-[min(50dvh,34rem)] min-h-[22rem]' : 'h-auto min-h-0') : 'h-full'
      }`}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 lg:px-4">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Agent Response</p>
          <p className="truncate text-sm font-semibold" title={active.workspace && active.tab ? `${active.workspace} · ${active.tab}` : active.label}>
            {active.workspace && active.tab ? (
              <>
                <span>{active.workspace}</span>
                <span className="text-muted-foreground/60 mx-1.5">·</span>
                <span>{active.tab}</span>
              </>
            ) : (
              active.label
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5 lg:hidden">
          {activeTimelineMessages.length > 0 && (
            <button
              type="button"
              onClick={() => setHistoryExpanded(!historyExpanded)}
              className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            >
              {historyExpanded ? 'Hide history' : 'Show history'}
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
      <div className="hidden min-h-0 border-b border-border/60 lg:block">
        <OverlayScrollArea className="max-h-52" style={{ overscrollBehaviorY: 'contain' }}>
          <SessionList chips={sessions} activeSessionKey={activeSessionKey} unreadCountBySession={unreadCountBySession} onActivateSession={onActivateSession} />
        </OverlayScrollArea>
      </div>
      <OverlayScrollArea
        className="min-h-0 flex-1"
        data-live-timeline-scroll="true"
        tabIndex={0}
        style={{ overscrollBehaviorY: 'contain' }}
      >
        {newReplyCount > 0 && (
          <div className="sticky top-0 z-10 px-3 pt-2">
            <button
              type="button"
              onClick={onJumpToNewReplies}
              className="w-full rounded-md border border-primary/35 bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {newReplyCount} new repl{newReplyCount === 1 ? 'y' : 'ies'} · Jump to new replies
            </button>
          </div>
        )}
        <MessagesBrowser
          messages={filteredMessages}
          selectedMessageId={selectedMessageId}
          onSelect={onSelectMessage}
          annotationCounts={annotationCounts}
          captainEchoes={filteredEchoes}
          chronological
          chatLayout
          autoLoadOnScroll
          listLabel="Session responses"
          emptyLabel="No assistant response in this session yet."
          jumpToLatestSignal={jumpToLatestSignal}
        />
      </OverlayScrollArea>
      {mobileSessionsOpen && (
        <div className="fixed inset-0 z-[80] flex bg-black/50 lg:hidden" role="presentation" onClick={() => setMobileSessionsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Choose live session"
            className="flex h-[100dvh] w-full flex-col bg-card"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <div><h2 className="text-sm font-semibold">Live sessions</h2><p className="text-xs text-muted-foreground">Choose a pane without leaving this response.</p></div>
              <button type="button" onClick={() => setMobileSessionsOpen(false)} className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground">Done</button>
            </header>
            <OverlayScrollArea className="min-h-0 flex-1" style={{ overscrollBehaviorY: 'contain' }}>
              <SessionList
                chips={sessions}
                activeSessionKey={activeSessionKey}
                unreadCountBySession={unreadCountBySession}
                onActivateSession={onActivateSession}
                onAfterActivate={() => setMobileSessionsOpen(false)}
              />
            </OverlayScrollArea>
          </section>
        </div>
      )}
    </section>
  );
});

LiveSessionTimeline.displayName = 'LiveSessionTimeline';
