// Presentational pinned "pane chips" row for the Ex-Plannotator live-pane
// header. One chip per live Pi pane, so the captain sees every running pane at a
// glance and can switch panes with a single click — WITHOUT opening the annotate
// message-picker (which owns "which message to annotate", not "which pane am I
// looking at"). See packages/editor/App.tsx live pane header.
//
// This module is intentionally presentational and side-effect-free: all chip
// derivation (identity, active-first ordering, overflow, CTX warning, recent
// commands) lives in the pure ./livePaneChips module, which is unit-tested
// separately. That keeps this component thin and DOM-testable in isolation.

import React from 'react';
import {
  deriveLivePaneChips,
  type LivePaneChip as LivePaneChipData,
  type PaneChipSource,
} from './livePaneChips';

// Compact CTX% indicator. When usage crosses the high-water threshold the
// derivation flags `contextWarning`, and we switch to a warning tone so a
// near-full pane is legible at a glance. The percent is also the accessible
// text, so tone is never the sole carrier of meaning.
const PaneChipContext = ({ percent, warning }: { percent: number | null; warning: boolean }) => {
  if (percent === null) return null;
  return (
    <span
      className={`inline-flex items-center rounded px-1 text-[10px] font-medium tabular-nums ${
        warning ? 'bg-warning/20 text-warning-strong' : 'text-muted-foreground/80'
      }`}
      title={warning ? `Context ${percent}% — near full` : `Context ${percent}%`}
    >
      {percent}%
    </span>
  );
};

// A single pinned pane chip: click to switch the viewed pane (drives the same
// selection the annotate picker drives, but owns "which pane am I looking at",
// leaving "which message to annotate" to the picker). Shows pane identity +
// branch + the reused live activity chip + a compact CTX%. The selected pane is
// visually distinguished and marked aria-current. The optional "$" affordance
// reveals the pane's latest redacted shell commands (Part 2).
export const LivePaneChipButton = ({
  chip,
  onSelect,
  onToggleCommands,
  commandsOpen,
}: {
  chip: LivePaneChipData;
  onSelect: (messageId: string) => void;
  onToggleCommands: (paneId: string) => void;
  commandsOpen: boolean;
}) => {
  const activityLabel = chip.activity?.label;
  const [showOlderCommands, setShowOlderCommands] = React.useState(false);
  // Recent commands arrive oldest→newest; the LATEST is the last entry and is
  // the only one shown by default. Older commands live behind an in-popover
  // toggle so the inline view never floods with a full command history.
  const latestCommand = chip.recentCommands[chip.recentCommands.length - 1];
  const olderCommands = chip.recentCommands.slice(0, -1);
  return (
    <span className="relative inline-flex shrink-0 items-stretch">
      <button
        type="button"
        onClick={() => onSelect(chip.messageId)}
        aria-current={chip.isSelected ? 'true' : undefined}
        title={`${chip.label}${chip.branch ? ` · ⎇ ${chip.branch}` : ''}${activityLabel ? ` · ${activityLabel}` : ''}`}
        className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
          chip.isSelected
            ? 'border-primary/60 bg-primary/15 text-foreground ring-1 ring-primary/40'
            : 'border-border bg-muted/40 text-foreground/80 hover:bg-muted/70'
        } ${chip.recentCommands.length > 0 ? 'rounded-r-none' : ''}`}
      >
        {chip.activity && (
          <span
            aria-hidden="true"
            className={`text-[10px] ${
              chip.activity.tone === 'active'
                ? 'text-primary'
                : chip.activity.tone === 'waiting'
                  ? 'text-warning-strong'
                  : chip.activity.tone === 'blocked'
                    ? 'text-destructive'
                    : 'text-muted-foreground/60'
            }`}
          >
            {chip.activity.glyph}
          </span>
        )}
        {chip.workspaceShared && chip.workspace && chip.tab ? (
          // Every visible chip shares one workspace, so the identical `workspace ·`
          // prefix is redundant noise that squeezes out the distinguishing tab.
          // De-emphasize the prefix and give the tab the space. The full
          // `workspace · tab` still lives in the button title + sr-only text.
          <span className="inline-flex min-w-0 items-baseline gap-1">
            <span aria-hidden="true" className="shrink-0 truncate text-muted-foreground/40 max-w-[4rem]">
              {chip.workspace} ·
            </span>
            <span className="min-w-0 truncate">{chip.tab}</span>
          </span>
        ) : (
          <span className="min-w-0 truncate">{chip.label}</span>
        )}
        {chip.branch && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground/70">
            <span aria-hidden="true">⎇</span>
            <span className="max-w-[6rem] truncate">{chip.branch}</span>
          </span>
        )}
        <PaneChipContext percent={chip.contextPercent} warning={chip.contextWarning} />
        <span className="sr-only">
          {chip.isSelected ? 'Selected pane. ' : ''}
          {activityLabel ? `Status: ${activityLabel}.` : ''}
        </span>
      </button>
      {chip.recentCommands.length > 0 && (
        <button
          type="button"
          onClick={() => onToggleCommands(chip.paneId)}
          aria-expanded={commandsOpen}
          aria-label={`Recent commands for ${chip.label}`}
          title="Recent commands"
          className={`inline-flex shrink-0 items-center rounded-r-full border border-l-0 px-1.5 text-[11px] font-medium transition-colors ${
            chip.isSelected
              ? 'border-primary/60 bg-primary/15 text-foreground/80 ring-1 ring-primary/40'
              : 'border-border bg-muted/40 text-foreground/60 hover:bg-muted/70'
          }`}
        >
          <span aria-hidden="true">$</span>
        </button>
      )}
      {commandsOpen && latestCommand && (
        <span
          role="group"
          aria-label={`Latest commands for ${chip.label}`}
          className="absolute left-0 top-full z-30 mt-1 flex max-w-[24rem] flex-col gap-0.5 rounded border border-border bg-popover p-2 text-[11px] shadow-md"
        >
          {/* Latest command first: the on-demand view still leads with the most
              recent command, matching the inline latest-only rule. */}
          <code className="block truncate font-mono text-foreground/90">
            <span aria-hidden="true" className="text-muted-foreground/50">$ </span>
            {latestCommand}
          </code>
          {olderCommands.length > 0 && !showOlderCommands && (
            <button
              type="button"
              onClick={() => setShowOlderCommands(true)}
              className="mt-0.5 self-start text-[10px] font-medium text-muted-foreground hover:text-foreground"
            >
              {`Show ${olderCommands.length} older`}
            </button>
          )}
          {olderCommands.length > 0 && showOlderCommands &&
            [...olderCommands].reverse().map((command, index) => (
              <code key={index} className="block truncate font-mono text-muted-foreground">
                <span aria-hidden="true" className="text-muted-foreground/50">$ </span>
                {command}
              </code>
            ))}
        </span>
      )}
    </span>
  );
};

// The pinned pane-chips row: one chip per live Pi pane, always visible in the
// live-pane header so the captain sees every running pane at a glance and can
// switch with a single click. Active-first ordering with a `+N more` overflow
// keeps the header from overflowing. Selection is the SAME selection the picker
// drives; annotation semantics are untouched. Renders nothing when there are
// fewer than two panes (a single pane is already described by the status line).
export const LivePaneChipsRow = ({
  sources,
  selectedMessageId,
  reviewRoundStatus,
  contextHandoffHighPercent,
  onSelect,
}: {
  sources: PaneChipSource[];
  selectedMessageId: string | null;
  reviewRoundStatus?: string | null;
  contextHandoffHighPercent?: number;
  onSelect: (messageId: string) => void;
}) => {
  const [showAll, setShowAll] = React.useState(false);
  const [openCommandsPaneId, setOpenCommandsPaneId] = React.useState<string | null>(null);
  const { visible, overflow } = React.useMemo(
    () => deriveLivePaneChips(sources, {
      selectedMessageId,
      reviewRoundStatus,
      ctxWarnThreshold: contextHandoffHighPercent,
    }),
    [sources, selectedMessageId, reviewRoundStatus, contextHandoffHighPercent],
  );
  const handleToggleCommands = React.useCallback(
    (paneId: string) => setOpenCommandsPaneId((current) => (current === paneId ? null : paneId)),
    [],
  );
  // Only a genuine multi-pane herd benefits from a switcher row.
  if (visible.length + overflow.length < 2) return null;
  const shown = showAll ? [...visible, ...overflow] : visible;
  return (
    <div className="border-b border-border/60 bg-background/40 px-4 py-1.5 flex-shrink-0">
      <div
        role="group"
        aria-label="Live Pi panes — click to switch pane"
        className="flex flex-wrap items-center gap-1.5"
      >
        {shown.map((chip) => (
          <LivePaneChipButton
            key={chip.paneId}
            chip={chip}
            onSelect={onSelect}
            onToggleCommands={handleToggleCommands}
            commandsOpen={openCommandsPaneId === chip.paneId}
          />
        ))}
        {overflow.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            aria-expanded={showAll}
            className="inline-flex shrink-0 items-center rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
          >
            {showAll ? 'Show less' : `+${overflow.length} more`}
          </button>
        )}
      </div>
    </div>
  );
};
