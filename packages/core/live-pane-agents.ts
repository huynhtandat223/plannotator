/**
 * Live-pane agent capability registry (browser-safe, zero-dep).
 *
 * Herdr reports an agent kind per pane (`pi`, `claude`, `codex`, `opencode`,
 * …). Discovery in `apps/herdr-process-service/server.ts` is deliberately
 * kind-agnostic: it admits every agent entry the snapshot describes and never
 * branches on the kind's name. This table is the ONE place that knows what a
 * given kind can actually deliver beyond that.
 *
 * Four surfaces come straight from Herdr's snapshot and are therefore always
 * available for every kind, present and future — identity (workspace/tab/pane),
 * status, working directory, and focus. They are intentionally NOT capabilities
 * here; nothing can degrade them.
 *
 * Everything richer than that came from the Pi extension registering into
 * `/api/panel-session`, so it must be declared per kind. A kind with no entry
 * falls back to {@link unknownLivePaneAgentProfile}, which claims nothing.
 * Adding a fifth agent kind therefore requires no discovery change at all: at
 * worst the pane shows up with every rich capability named as missing, which is
 * the honest outcome — never an empty surface pretending to work.
 */

/** Capabilities a live pane may or may not be able to source, beyond Herdr's own snapshot. */
export const LIVE_PANE_CAPABILITIES = [
  "transcript",
  "activityTrail",
  "contextUsage",
  "commands",
  "handoff",
  "feedback",
  "exAICompanion",
] as const;

export type LivePaneCapabilityId = (typeof LIVE_PANE_CAPABILITIES)[number];

/** Short user-facing name for each capability, used in the "not available" notice. */
export const LIVE_PANE_CAPABILITY_LABELS: Record<LivePaneCapabilityId, string> = {
  transcript: "Chat transcript",
  activityTrail: "Activity trail",
  contextUsage: "Context usage",
  commands: "Slash commands",
  handoff: "Context handoff",
  feedback: "Send feedback",
  exAICompanion: "Ex AI Chat",
};

/**
 * Where a kind's transcript rows come from.
 * - `pi-extension`: the Ex-Plannotator Pi extension pushes them to /api/panel-session.
 * - `claude-session-log`: the host reads Claude Code's own cwd-keyed JSONL session log.
 */
export type LivePaneTranscriptSource = "pi-extension" | "claude-session-log";

export type LivePaneAgentProfile = {
  /** Raw agent kind exactly as Herdr reports it. */
  agent: string;
  /** Human label for the kind, e.g. "Claude Code". */
  label: string;
  /** How the host sources this kind's transcript, or null when it cannot. */
  transcriptSource: LivePaneTranscriptSource | null;
  /**
   * Capability → user-facing reason it is unavailable for this kind. A
   * capability absent from this map is supported. Reasons are shown verbatim in
   * the UI, so they name the missing mechanism rather than saying "unavailable".
   */
  unsupported: Partial<Record<LivePaneCapabilityId, string>>;
};

/** One rendered limitation: what is missing, and why, in the user's words. */
export type LivePaneLimitation = {
  id: LivePaneCapabilityId;
  label: string;
  reason: string;
};

const NO_EXTENSION_ACTIVITY =
  "publishes no per-turn tool activity to Plannotator, so there is no activity trail or recent-command list.";
const NO_EXTENSION_COMMANDS =
  "does not advertise its slash commands to Plannotator, so there is nothing to run from here.";
const NO_EXTENSION_HANDOFF =
  "advertises no handoff-class command, so Plannotator has nothing to fire.";
const NO_EXTENSION_FEEDBACK =
  "has no Plannotator extension to claim and inject feedback, so this pane is read-only here.";
const NO_EXTENSION_EX_AI =
  "cannot be paired: Ex AI Chat drives a companion Pi session bound to a Pi pane.";

/** Compose the shared "only Pi does this" reasons for a named kind. */
function extensionGapReasons(label: string): Partial<Record<LivePaneCapabilityId, string>> {
  return {
    activityTrail: `${label} ${NO_EXTENSION_ACTIVITY}`,
    commands: `${label} ${NO_EXTENSION_COMMANDS}`,
    handoff: `${label} ${NO_EXTENSION_HANDOFF}`,
    feedback: `${label} ${NO_EXTENSION_FEEDBACK}`,
    exAICompanion: `${label} ${NO_EXTENSION_EX_AI}`,
  };
}

/**
 * Known agent kinds. Keys are Herdr's `agent` values, lowercased.
 *
 * Every reason names the concrete missing mechanism. "Could exist with work"
 * and "cannot exist" both degrade the same way in the UI — what differs is what
 * the reason tells the reader, so a future contributor knows where to look.
 */
const LIVE_PANE_AGENT_PROFILES: Record<string, LivePaneAgentProfile> = {
  pi: {
    agent: "pi",
    label: "Pi",
    transcriptSource: "pi-extension",
    unsupported: {},
  },
  claude: {
    agent: "claude",
    label: "Claude Code",
    // Claude Code writes a cwd-keyed JSONL session log, which the host already
    // knows how to read (apps/hook/server/session-log.ts). That is the whole
    // transcript, read-only.
    transcriptSource: "claude-session-log",
    unsupported: {
      ...extensionGapReasons("Claude Code"),
      contextUsage:
        "Claude Code's session log records token usage but not the model's context window, so a percentage here would be a guess.",
    },
  },
  codex: {
    agent: "codex",
    label: "Codex",
    // Plannotator can already parse a Codex rollout (apps/hook/server/codex-session.ts),
    // but only once it knows WHICH rollout: resolution is by CODEX_THREAD_ID,
    // which Herdr's snapshot does not carry. A cwd → rollout resolver would close this.
    transcriptSource: null,
    unsupported: {
      ...extensionGapReasons("Codex"),
      transcript:
        "Codex rollout files are keyed by thread id, which Herdr's snapshot does not carry, so Plannotator cannot tell which rollout belongs to this pane.",
      contextUsage:
        "Codex context usage lives in the rollout file, which Plannotator cannot resolve for this pane yet.",
    },
  },
  opencode: {
    agent: "opencode",
    label: "OpenCode",
    // The OpenCode plugin talks to a live session over the OpenCode SDK from
    // inside the agent process. Nothing in this repo reads OpenCode sessions
    // from disk, so a detached host has no transcript source at all.
    transcriptSource: null,
    unsupported: {
      ...extensionGapReasons("OpenCode"),
      transcript:
        "OpenCode exposes its sessions only to a plugin running inside the agent; Plannotator has no way to read them from outside that process.",
      contextUsage:
        "OpenCode reports context usage only to an in-process plugin, which this host is not.",
    },
  },
};

/** Title-case a raw agent kind for display, e.g. `my-agent` → `My Agent`. */
function labelFromAgentKind(agent: string): string {
  const words = agent.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return "Unknown agent";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Profile for a kind this build has never heard of. It promises nothing beyond
 * Herdr's own snapshot fields, so an unrecognised pane is listed honestly
 * instead of being hidden or shown as a dead rich pane.
 */
export function unknownLivePaneAgentProfile(agent: string): LivePaneAgentProfile {
  const label = labelFromAgentKind(agent);
  const noIntegration = `Plannotator has no integration for ${label} panes, so only Herdr's own pane identity, status and folder are available.`;
  return {
    agent,
    label,
    transcriptSource: null,
    unsupported: {
      transcript: noIntegration,
      activityTrail: noIntegration,
      contextUsage: noIntegration,
      commands: noIntegration,
      handoff: noIntegration,
      feedback: noIntegration,
      exAICompanion: noIntegration,
    },
  };
}

/** Resolve the capability profile for a Herdr agent kind. Never throws. */
export function livePaneAgentProfile(agent: string | undefined | null): LivePaneAgentProfile {
  const kind = (agent ?? "").trim().toLowerCase();
  // A pane whose kind Herdr did not report is the same situation as an
  // unrecognised kind: claim nothing beyond the snapshot's own fields.
  if (!kind) return { ...unknownLivePaneAgentProfile("unknown"), label: "Unknown agent" };
  return LIVE_PANE_AGENT_PROFILES[kind] ?? unknownLivePaneAgentProfile(kind);
}

/** True when this agent kind can source the capability. */
export function supportsLivePaneCapability(
  agent: string | undefined | null,
  capability: LivePaneCapabilityId,
): boolean {
  return livePaneAgentProfile(agent).unsupported[capability] === undefined;
}

/**
 * Reason a capability is unavailable for this agent kind, or null when it is
 * available. Servers put this straight into an error body; the UI puts it
 * straight into a tooltip.
 */
export function livePaneCapabilityReason(
  agent: string | undefined | null,
  capability: LivePaneCapabilityId,
): string | null {
  return livePaneAgentProfile(agent).unsupported[capability] ?? null;
}

/** Every unavailable capability for this kind, in declaration order, ready to render. */
export function livePaneLimitations(agent: string | undefined | null): LivePaneLimitation[] {
  const profile = livePaneAgentProfile(agent);
  return LIVE_PANE_CAPABILITIES.flatMap((id) => {
    const reason = profile.unsupported[id];
    return reason ? [{ id, label: LIVE_PANE_CAPABILITY_LABELS[id], reason }] : [];
  });
}

/** Display label for a Herdr agent kind. */
export function livePaneAgentLabel(agent: string | undefined | null): string {
  return livePaneAgentProfile(agent).label;
}
