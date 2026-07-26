// Presentational "this pane is limited" notice for the Ex-Plannotator
// live-pane header. See packages/editor/App.tsx live pane header.
//
// Herdr surfaces panes from several agents, but everything richer than pane
// identity/status/cwd/focus came from the Pi extension registering into
// /api/panel-session. A Claude Code, Codex or OpenCode pane that simply
// rendered the Pi chrome would look alive and do nothing, which is worse than
// not listing it at all. So each missing capability is named here, with the
// reason available on demand, while App.tsx disables the matching affordance
// and the host refuses the matching request with the same reason.
//
// The capability data itself is derived by the pure, unit-tested registry in
// @plannotator/core/live-pane-agents; this module is presentational and
// side-effect-free. A pane whose agent supports everything (Pi) renders null,
// which is what keeps the Pi header byte-for-byte what it was.

import React, { useState } from 'react';
import type { LivePaneLimitation } from '@plannotator/core/live-pane-agents';

export const LivePaneLimitationsNotice = ({
  agentLabel,
  limitations,
}: {
  agentLabel: string;
  limitations: LivePaneLimitation[];
}) => {
  const [expanded, setExpanded] = useState(false);
  if (limitations.length === 0) return null;
  return (
    <div className="border-b border-warning/25 bg-warning/10 px-4 py-2 text-xs text-warning-foreground flex-shrink-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden="true">⚠</span>
        <span className="font-medium">{agentLabel} panes are limited in Plannotator.</span>
        <span className="min-w-0">
          Not available here: {limitations.map((limitation) => limitation.label).join(' · ')}.
        </span>
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="rounded border border-warning/40 px-1.5 py-0.5 font-medium hover:bg-warning/20"
        >
          {expanded ? 'Hide details' : 'Why?'}
        </button>
      </div>
      {expanded && (
        <ul className="mt-2 flex flex-col gap-1 pl-5">
          {limitations.map((limitation) => (
            <li key={limitation.id} className="list-disc">
              <span className="font-medium">{limitation.label}</span> — {limitation.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
