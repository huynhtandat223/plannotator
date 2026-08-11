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

/**
 * How "Send feedback / message" reaches a kind. The two mechanisms are NOT
 * equivalent, and the UI must never pretend they are:
 *
 * - `pi-extension`: the browser queues a batch for one live `{paneId,
 *   sessionId}`; only the matching Pi extension inside the agent process claims
 *   it (at-most-once) and injects it with `pi.sendUserMessage`. Structured,
 *   session-exact, invalidated when the session changes or closes. Strictly
 *   better where it applies — always preferred when an extension is present.
 * - `herdr-composer`: the host types the text into the pane's composer through
 *   Herdr and submits it with Enter. Delivery is confirmed only by Herdr's own
 *   agent state observing a turn start; the host cannot prove which session is
 *   active in the pane and refuses to send while the agent is mid-turn. Each
 *   composer-delivered kind carries a user-facing caveat saying exactly this.
 * - `null`: no mechanism — the pane is read-only here, with a reason in
 *   `unsupported.feedback`.
 */
export type LivePaneFeedbackDeliveryMechanism = "pi-extension" | "herdr-composer";

export type LivePaneAgentProfile = {
  /** Raw agent kind exactly as Herdr reports it. */
  agent: string;
  /** Human label for the kind, e.g. "Claude Code". */
  label: string;
  /** How the host sources this kind's transcript, or null when it cannot. */
  transcriptSource: LivePaneTranscriptSource | null;
  /**
   * How sends reach this kind, or null when they cannot. Exactly one of these
   * holds: `feedbackDelivery` is null and `unsupported.feedback` names why the
   * pane is read-only, or `feedbackDelivery` is set and `feedback` is absent
   * from `unsupported`. `herdr-composer` additionally requires
   * {@link composerDeliveryCaveat}.
   */
  feedbackDelivery: LivePaneFeedbackDeliveryMechanism | null;
  /**
   * User-facing caveat for `herdr-composer` delivery, rendered wherever sending
   * is offered so the weaker guarantees are visible before the user relies on
   * them. Present exactly when `feedbackDelivery` is `herdr-composer`.
   */
  composerDeliveryCaveat?: string;
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
const NO_EXTENSION_EX_AI =
  "cannot be paired: Ex AI Chat drives a companion Pi session bound to a Pi pane.";

/**
 * Compose the shared "only Pi does this" reasons for a named kind. Deliberately
 * does NOT include `feedback`: the named kinds below all receive sends through
 * Herdr composer delivery, whose weaker guarantees are stated in
 * {@link composerDeliveryCaveat} instead of an unsupported reason.
 */
function extensionGapReasons(label: string): Partial<Record<LivePaneCapabilityId, string>> {
  return {
    activityTrail: `${label} ${NO_EXTENSION_ACTIVITY}`,
    commands: `${label} ${NO_EXTENSION_COMMANDS}`,
    handoff: `${label} ${NO_EXTENSION_HANDOFF}`,
    exAICompanion: `${label} ${NO_EXTENSION_EX_AI}`,
  };
}

/**
 * The honest, user-facing description of Herdr composer delivery for a named
 * kind. Every claim here must be one this path actually honours: it types once,
 * submits with Enter, confirms only by watching the agent start a turn, refuses
 * while the agent is busy, and cannot verify the pane's active session.
 */
function composerDeliveryCaveat(label: string): string {
  return `${label} has no Plannotator extension, so sends are typed into the pane's composer through Herdr and submitted with Enter. Delivery is confirmed only by watching the agent start a turn — Plannotator cannot verify which session is active in the pane, and it refuses to send while the agent is busy.`;
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
    feedbackDelivery: "pi-extension",
    unsupported: {},
  },
  claude: {
    agent: "claude",
    label: "Claude Code",
    // Claude Code writes a cwd-keyed JSONL session log, which the host already
    // knows how to read (apps/hook/server/session-log.ts). That is the whole
    // transcript, read-only.
    transcriptSource: "claude-session-log",
    feedbackDelivery: "herdr-composer",
    composerDeliveryCaveat: composerDeliveryCaveat("Claude Code"),
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
    feedbackDelivery: "herdr-composer",
    composerDeliveryCaveat: composerDeliveryCaveat("Codex"),
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
    feedbackDelivery: "herdr-composer",
    composerDeliveryCaveat: composerDeliveryCaveat("OpenCode"),
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
    // Herdr could type into an unknown kind's composer too, but nothing here
    // knows that kind's composer behaviour (completion popups, submit keys,
    // busy semantics), so an unlisted kind claims no delivery at all. Adding a
    // profile entry above is the deliberate act that turns delivery on.
    feedbackDelivery: null,
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

/**
 * Why composer delivery refuses BEFORE typing anything.
 *
 * These live here rather than in the host's delivery module because both sides
 * now say them: the host returns them on a 409, and a browser surface that
 * offers sending must be able to refuse for the same reason in the same words
 * without issuing a request. Two copies of this text would drift, and the
 * drifted one would be the one a captain reads while deciding whether their
 * message landed. `apps/herdr-process-service/herdr-composer-delivery.ts`
 * re-exports both, so the host's own imports are unchanged.
 */
export const COMPOSER_BUSY_REASON =
  "This pane's agent is mid-turn. Typing now would queue the text in its composer where delivery cannot be confirmed, and a retry could send it twice. Wait for the pane to go idle, then send again.";

export const COMPOSER_UNREADABLE_REASON =
  "Herdr could not read this pane's agent state, so Plannotator cannot safely type into its composer.";

/**
 * Whether `content` will open the agent TUI's own completion popup when typed
 * into its composer.
 *
 * Stated once, here, because two consumers must agree exactly: the host delays
 * its first Enter for popup text, and a browser send surface refuses that text
 * outright (below). A drifted second copy would let the browser offer a send
 * the host then handles under different assumptions.
 */
export function composerOpensCompletionPopup(content: string): boolean {
  return content.startsWith("/") || content.startsWith("$");
}

/**
 * Why composer delivery refuses popup-opening text.
 *
 * Composer delivery types the text, then presses Enter up to three times,
 * because a first Enter swallowed by a completion popup starts no turn and the
 * next one submits. That is sound for ordinary prose. It is NOT sound for a
 * slash command, and the failure was observed rather than theorised: sending
 * `/model` to a Claude Code pane typed it, Enter #1 accepted the popup entry,
 * Enter #2 submitted the command — which opened an interactive picker instead
 * of starting a turn, leaving the agent `idle` — and Enter #3 confirmed that
 * picker. Three blind Enters walked through a dialog the captain never saw.
 *
 * There is no safe number of Enters here: the whole mechanism cannot tell a
 * consumed keystroke from an ignored one, so any retry can land inside a modal.
 * Sending one Enter and stopping is no better — it leaves the command typed and
 * armed in a composer the captain has no way to clear from Watch. So nothing is
 * typed at all, and the two paths that CAN run a command safely are named.
 *
 * Keystroke forwarding (issue #57) is the real answer: there the captain's own
 * Enter is the only Enter, and the popup is theirs to operate.
 */
export const COMPOSER_COMMAND_TEXT_REASON =
  "Text starting with / or $ opens this agent's own completion popup, and composer delivery submits by pressing Enter — which can select a suggestion and confirm a dialog you never saw. Nothing was typed. Use the advertised commands control, or type it in the pane itself.";

/**
 * The reason this exact text cannot be sent to this agent kind, or null.
 *
 * Only composer delivery is affected. Extension delivery hands the text to a
 * queue as a message and presses no keys, so a leading `/` there is the
 * receiving agent's business, not a delivery hazard.
 */
export function composerCommandTextRefusal(agent: string | undefined | null, content: string): string | null {
  if (livePaneAgentProfile(agent).feedbackDelivery !== "herdr-composer") return null;
  return composerOpensCompletionPopup(content) ? COMPOSER_COMMAND_TEXT_REASON : null;
}

/**
 * Everything a send surface needs to describe delivery for one agent kind,
 * derived from this registry alone.
 *
 * It exists so a UI can render the mechanism, its note, its caveat and its
 * refusal without ever asking "is this Pi?". A kind added to the table above
 * gets correct copy here for free; a kind absent from it says exactly what it
 * cannot do, in the registry's own words.
 */
export type LivePaneSendCopy = {
  mechanism: LivePaneFeedbackDeliveryMechanism | null;
  /** Short line shown next to the composer, before anything is sent. */
  note: string;
  /** The full honest caveat for composer delivery, or null when there is nothing to caveat. */
  caveat: string | null;
  /** Why sending is impossible for this kind, or null when it is possible. */
  unavailableReason: string | null;
};

export function livePaneSendCopy(agent: string | undefined | null): LivePaneSendCopy {
  const profile = livePaneAgentProfile(agent);
  if (profile.feedbackDelivery === "pi-extension") {
    return {
      mechanism: "pi-extension",
      // "Queued", never "delivered": the host hands the text to a queue that
      // only the matching extension can claim, and nothing reports that claim
      // back to the browser. Saying more than this would be inventing a receipt.
      note: `Queued for the selected ${profile.label} session — its extension claims and delivers it.`,
      caveat: null,
      unavailableReason: null,
    };
  }
  if (profile.feedbackDelivery === "herdr-composer") {
    return {
      mechanism: "herdr-composer",
      note: `Typed into the ${profile.label} pane's composer through Herdr and submitted with Enter.`,
      caveat: profile.composerDeliveryCaveat ?? null,
      unavailableReason: null,
    };
  }
  return {
    mechanism: null,
    note: "",
    caveat: null,
    unavailableReason: profile.unsupported.feedback ?? null,
  };
}

/**
 * How sends reach this agent kind, or null when they cannot. The host selects
 * its delivery path from this — never from the kind's name — so a new kind
 * gains delivery by declaring it in its profile, with no discovery change.
 */
export function livePaneFeedbackDelivery(
  agent: string | undefined | null,
): LivePaneFeedbackDeliveryMechanism | null {
  return livePaneAgentProfile(agent).feedbackDelivery;
}

/**
 * The user-facing caveat for Herdr composer delivery, or null for kinds that
 * deliver through an extension (nothing to caveat) or not at all (the reason
 * lives in `unsupported.feedback` instead).
 */
export function livePaneComposerCaveat(agent: string | undefined | null): string | null {
  const profile = livePaneAgentProfile(agent);
  return profile.feedbackDelivery === "herdr-composer" ? profile.composerDeliveryCaveat ?? null : null;
}
