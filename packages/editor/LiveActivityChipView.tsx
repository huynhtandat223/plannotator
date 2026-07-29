// Presentational live "currently doing" chip for the Ex-Plannotator live-pane
// header. It promotes agentStatus + activity (derived by ./liveActivityChip) into
// a SINGLE legible, high-contrast signal — folding in the state precedence the
// old plain status pill also carried, so the working state is represented ONCE
// (no more `● Thinking…` + `● Working` duplication). See packages/editor/App.tsx.
//
// Meaning is always carried by the text label, never by colour/glyph/animation
// alone. The "actively working right now" states (thinking / running a tool /
// delegating to a subagent) render ONE friendly looping indicator (pure CSS,
// see index.css .live-working-dot) so motion uniquely signals live work;
// prefers-reduced-motion falls back to a static filled dot. Calm states
// (idle / blocked / waiting) keep their static glyph.

import React from 'react';
import type { LiveActivityChip as LiveActivityChipData } from './liveActivityChip';

export const LiveActivityChip = ({
  chip,
  paneName,
}: {
  chip: LiveActivityChipData;
  paneName?: string;
}) => {
  const toneClass =
    chip.tone === 'active'
      ? 'border-primary/40 bg-primary/15 text-foreground'
      : chip.tone === 'waiting'
        ? 'border-warning/40 bg-warning/15 text-warning-strong'
        : chip.tone === 'blocked'
          ? 'border-destructive/40 bg-destructive/15 text-destructive'
          : 'border-border bg-muted/50 text-foreground/80';
  // Tie the single indicator to the pane it describes: the pane name rides in
  // the hover title and the accessible label so the chip never reads as a
  // detached, free-floating status. The visible label stays compact.
  const title = paneName ? `${chip.label} · ${paneName}` : chip.label;
  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      aria-label={paneName ? `${chip.label} — ${paneName}` : undefined}
      className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${toneClass}`}
    >
      {chip.animated ? (
        // ONE friendly looping indicator for the "working right now" states.
        // Pure CSS (see index.css .live-working-dot); prefers-reduced-motion
        // falls back to a static filled dot. The label still carries the
        // meaning, so the animation is never the sole signal.
        <span aria-hidden="true" className="live-working-dot" data-testid="live-working-dot" />
      ) : (
        <span aria-hidden="true" data-testid="live-static-glyph">{chip.glyph}</span>
      )}
      <span>{chip.label}</span>
    </span>
  );
};
