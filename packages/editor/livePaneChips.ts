// Derives the pinned "pane chips" row shown in the Ex-Plannotator live-pane
// header. One chip per live Pi pane, so the captain can see every running pane
// at a glance and switch panes with a single click — without opening the
// annotate message-picker (which owns "which message to annotate", not "which
// pane am I looking at"). See packages/editor/App.tsx live pane header.
//
// Everything here is computed from data already on the wire (the same
// PickerMessage rows the picker consumes): pane identity, branch, agentStatus +
// activity (reused via deriveLiveActivityChip — the state precedence is NOT
// reinvented here), context usage, and the optional per-turn activityTrail.

import { CONTEXT_HANDOFF_HIGH_PERCENT } from '@plannotator/shared/context-handoff-threshold';
import {
  deriveLiveActivityChip,
  type LiveActivityChip,
  type LiveAgentStatus,
  type LiveActivity,
} from './liveActivityChip';

/** One activity-trail entry as published on the wire; command is optional and
 * already redacted+truncated at the source (see ex-pi-extension). */
export type PaneChipTrailEntry = {
  kind: 'tool' | 'subagent';
  name?: string;
  count: number;
  /** Redacted, single-line, hard-truncated command summary for bash-like tools. */
  command?: string;
};

/**
 * Minimal shape the chip row needs from a live pane row. PickerMessage is
 * structurally compatible; this narrow interface keeps the derivation unit
 * testable without constructing full snapshot rows.
 */
export interface PaneChipSource {
  messageId: string;
  paneId?: string;
  /** Workspace label (Herdr `panel.workspace`). */
  paneLabel?: string;
  /** Tab name (Herdr `panel.tab`) — the primary per-pane distinguishing label. */
  paneTab?: string;
  /** Secondary pane detail (panel name / description). */
  paneDescription?: string;
  gitBranch?: string;
  agentStatus?: LiveAgentStatus;
  activity?: LiveActivity;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  activityTrail?: readonly PaneChipTrailEntry[];
}

/** A render-ready pane chip. */
export interface LivePaneChip {
  paneId: string;
  /** The message this chip selects on click (drives the same selection the picker drives). */
  messageId: string;
  /** Primary display label: `workspace · tab` (or a distinct fallback). */
  label: string;
  workspace?: string;
  tab?: string;
  branch?: string;
  /** Reused live activity chip (may be null when there is nothing to show). */
  activity: LiveActivityChip | null;
  /** Rounded context-usage percent, or null when unknown. */
  contextPercent: number | null;
  /** True when contextPercent crosses the high-water threshold. */
  contextWarning: boolean;
  /** The pane currently viewed. */
  isSelected: boolean;
  /**
   * True when every chip in this derivation shares the SAME workspace, so the
   * common `workspace ·` prefix is redundant noise. The renderer de-emphasizes
   * (or drops) the shared prefix and gives the tab — the actual differentiator —
   * the space. `label` still carries the full `workspace · tab` for the a11y
   * title/fallback so meaning is never lost.
   */
  workspaceShared: boolean;
  /** Latest redacted command summaries (oldest→newest), bounded by config. */
  recentCommands: string[];
}

export interface LivePaneChipDerivation {
  /** Chips shown inline, active-first, selected pane always included. */
  visible: LivePaneChip[];
  /** Chips collapsed behind the `+N more` affordance. */
  overflow: LivePaneChip[];
  /** Total live panes. */
  total: number;
}

export interface LivePaneChipConfig {
  selectedMessageId?: string | null;
  /** Locally-known review round status; only applied to the selected pane's chip. */
  reviewRoundStatus?: string | null;
  /** Max chips shown inline before the rest collapse into `+N more`. Default 6. */
  maxVisible?: number;
  /** CTX% high-water mark for the warning tone. Default {@link DEFAULT_CTX_WARN_THRESHOLD}. */
  ctxWarnThreshold?: number;
  /** How many recent commands to surface per chip. Default 5. */
  recentCommandLimit?: number;
}

// Six inline chips: a captain typically runs a handful of panes, and six chips
// at ~150px each (label + branch + activity + CTX%) fit a ~1000px header row
// with the `+N more` affordance still visible. Beyond six we collapse so the
// header never overflows regardless of how many panes are live.
export const DEFAULT_MAX_VISIBLE_PANE_CHIPS = 6;
// Chip CTX warning tone shares ONE high-water source with the #26 handoff banner
// (PLANNOTATOR_HANDOFF_HIGH_PERCENT default). Before this the chip flipped at 75%
// while the banner fired at 72%, so 72–74% showed a banner but a calm chip. Both
// now read the same number, so the tone and the banner agree at the boundary.
export const DEFAULT_CTX_WARN_THRESHOLD = CONTEXT_HANDOFF_HIGH_PERCENT;
export const DEFAULT_RECENT_COMMAND_LIMIT = 5;

/** Sort key: active states first so working/blocked/waiting panes lead. */
const statusPriority = (chip: LivePaneChip): number => {
  const tone = chip.activity?.tone;
  if (tone === 'waiting') return 0;
  if (tone === 'blocked') return 1;
  if (tone === 'active') return 2;
  if (tone === 'idle') return 3;
  return 4;
};

/** Collapse a pane row's activityTrail into its latest command summaries. */
const recentCommandsFromTrail = (
  trail: readonly PaneChipTrailEntry[] | undefined,
  limit: number,
): string[] => {
  if (!Array.isArray(trail) || trail.length === 0 || limit <= 0) return [];
  const commands: string[] = [];
  for (const entry of trail) {
    if (entry && typeof entry.command === 'string' && entry.command.trim()) {
      commands.push(entry.command.trim());
    }
  }
  return commands.length > limit ? commands.slice(commands.length - limit) : commands;
};

const paneLabelParts = (source: PaneChipSource): { workspace?: string; tab?: string } => {
  const workspace = source.paneLabel?.trim() || undefined;
  const tab = source.paneTab?.trim() || undefined;
  return { workspace, tab };
};

/** Build the primary chip label from workspace + tab, with distinct fallbacks. */
const buildLabel = (source: PaneChipSource, workspace?: string, tab?: string): string => {
  if (workspace && tab) return `${workspace} · ${tab}`;
  if (tab) return tab;
  if (workspace) return workspace;
  const panel = source.paneDescription?.trim();
  if (panel) return panel;
  const suffix = (source.paneId ?? '').split(':').at(-1);
  return suffix ? `Pane ${suffix}` : 'Pane';
};

/**
 * Reduce live pane rows to one chip per pane. Groups rows by paneId (preserving
 * first-seen order), picks a representative message per pane (the selected row
 * when it belongs to the pane, else the latest row), sorts active-first, and
 * splits into visible/overflow. The selected pane is always kept visible.
 *
 * Duplicate labels are disambiguated with a short pane-id suffix so multiple
 * panes in one workspace never render identical indistinguishable chips.
 */
export const deriveLivePaneChips = (
  sources: readonly PaneChipSource[],
  config: LivePaneChipConfig = {},
): LivePaneChipDerivation => {
  const maxVisible = config.maxVisible ?? DEFAULT_MAX_VISIBLE_PANE_CHIPS;
  const ctxWarn = config.ctxWarnThreshold ?? DEFAULT_CTX_WARN_THRESHOLD;
  const commandLimit = config.recentCommandLimit ?? DEFAULT_RECENT_COMMAND_LIMIT;
  const selectedId = config.selectedMessageId ?? null;

  // Group by pane, preserving first-seen order.
  type Group = { paneId: string; order: number; latest: PaneChipSource; selected?: PaneChipSource };
  const groups = new Map<string, Group>();
  let order = 0;
  for (const source of sources) {
    if (!source) continue;
    const paneId = source.paneId ?? source.messageId;
    let group = groups.get(paneId);
    if (!group) {
      group = { paneId, order: order++, latest: source };
      groups.set(paneId, group);
    }
    // Later rows are newer (live transcript is chronological): keep the latest.
    group.latest = source;
    if (selectedId && source.messageId === selectedId) group.selected = source;
  }

  const chips: LivePaneChip[] = [];
  for (const group of groups.values()) {
    const isSelected = group.selected !== undefined;
    // Represent the pane with the selected row when it lives here, else the latest.
    const representative = group.selected ?? group.latest;
    const { workspace, tab } = paneLabelParts(representative);
    const percent = representative.contextUsage?.percent ?? null;
    const activity = deriveLiveActivityChip({
      agentStatus: representative.agentStatus,
      activity: representative.activity,
      // The review-round "waiting on you" state is scoped to the pane under review.
      reviewRoundStatus: isSelected ? config.reviewRoundStatus : null,
    });
    chips.push({
      paneId: group.paneId,
      messageId: representative.messageId,
      label: buildLabel(representative, workspace, tab),
      workspace,
      tab,
      branch: representative.gitBranch?.trim() || undefined,
      activity,
      contextPercent: percent === null ? null : Math.round(percent),
      contextWarning: percent !== null && percent >= ctxWarn,
      isSelected,
      // Provisional; set once all chips are known (below). Defaults false so a
      // lone pane keeps its full label.
      workspaceShared: false,
      recentCommands: recentCommandsFromTrail(representative.activityTrail, commandLimit),
    });
  }

  // When every chip shares one workspace, the common `workspace ·` prefix is
  // redundant: flag it so the renderer can de-emphasize/drop it and give the
  // tab the space. Needs >1 chip and every chip to carry the same workspace.
  const workspaces = new Set(chips.map((chip) => chip.workspace ?? ''));
  const workspaceShared =
    chips.length > 1 && workspaces.size === 1 && !workspaces.has('');
  if (workspaceShared) {
    for (const chip of chips) chip.workspaceShared = true;
  }

  disambiguateLabels(chips);

  // Stable active-first sort: primary = status priority, secondary = first-seen.
  const originalOrder = new Map(chips.map((chip, index) => [chip.paneId, index]));
  chips.sort((a, b) => {
    const byStatus = statusPriority(a) - statusPriority(b);
    if (byStatus !== 0) return byStatus;
    return (originalOrder.get(a.paneId) ?? 0) - (originalOrder.get(b.paneId) ?? 0);
  });

  const visible = chips.slice(0, maxVisible);
  const overflow = chips.slice(maxVisible);

  // The selected pane must always be visible: if it landed in overflow, swap it
  // into the last visible slot so the captain never loses sight of it.
  if (visible.length === maxVisible) {
    const hiddenSelectedIdx = overflow.findIndex((chip) => chip.isSelected);
    if (hiddenSelectedIdx !== -1) {
      const [selectedChip] = overflow.splice(hiddenSelectedIdx, 1);
      const displaced = visible[visible.length - 1];
      visible[visible.length - 1] = selectedChip;
      overflow.unshift(displaced);
    }
  }

  return { visible, overflow, total: chips.length };
};

/** Append a short pane-id suffix to any labels that would otherwise collide. */
function disambiguateLabels(chips: LivePaneChip[]): void {
  const counts = new Map<string, number>();
  for (const chip of chips) counts.set(chip.label, (counts.get(chip.label) ?? 0) + 1);
  for (const chip of chips) {
    if ((counts.get(chip.label) ?? 0) > 1) {
      const suffix = chip.paneId.split(':').at(-1);
      if (suffix) chip.label = `${chip.label} #${suffix}`;
    }
  }
}
