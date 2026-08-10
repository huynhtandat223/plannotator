import { describe, expect, test } from "bun:test";
import {
  COMPOSER_BUSY_REASON,
  COMPOSER_UNREADABLE_REASON,
  LIVE_PANE_CAPABILITIES,
  livePaneAgentLabel,
  livePaneAgentProfile,
  livePaneCapabilityReason,
  livePaneComposerCaveat,
  livePaneFeedbackDelivery,
  livePaneLimitations,
  livePaneSendCopy,
  supportsLivePaneCapability,
} from "./live-pane-agents";

describe("livePaneAgentProfile", () => {
  test("Pi supports every live-pane capability", () => {
    for (const capability of LIVE_PANE_CAPABILITIES) {
      expect(supportsLivePaneCapability("pi", capability)).toBe(true);
      expect(livePaneCapabilityReason("pi", capability)).toBeNull();
    }
    expect(livePaneLimitations("pi")).toEqual([]);
    expect(livePaneAgentProfile("pi").transcriptSource).toBe("pi-extension");
  });

  test("Claude Code has a transcript but names every capability it lacks", () => {
    expect(livePaneAgentProfile("claude").transcriptSource).toBe("claude-session-log");
    expect(supportsLivePaneCapability("claude", "transcript")).toBe(true);
    expect(livePaneLimitations("claude").map((limitation) => limitation.id).sort()).toEqual([
      "activityTrail",
      "commands",
      "contextUsage",
      "exAICompanion",
      "handoff",
    ]);
  });

  test("Pi keeps extension delivery; extensionless kinds declare composer delivery with an honest caveat", () => {
    expect(livePaneFeedbackDelivery("pi")).toBe("pi-extension");
    expect(livePaneComposerCaveat("pi")).toBeNull();
    for (const agent of ["claude", "codex", "opencode"]) {
      expect(livePaneFeedbackDelivery(agent)).toBe("herdr-composer");
      expect(supportsLivePaneCapability(agent, "feedback")).toBe(true);
      expect(livePaneCapabilityReason(agent, "feedback")).toBeNull();
      const caveat = livePaneComposerCaveat(agent);
      // The caveat must state exactly the guarantees this path honours: typed
      // composer delivery, turn-start confirmation, no session verification,
      // and refusal while busy. It is rendered verbatim in the UI.
      expect(caveat).toContain("typed into the pane's composer");
      expect(caveat).toContain("start a turn");
      expect(caveat).toContain("cannot verify which session");
      expect(caveat).toContain("refuses to send while the agent is busy");
    }
  });

  test("an unknown agent kind declares no delivery mechanism and keeps its feedback refusal", () => {
    expect(livePaneFeedbackDelivery("some-future-agent")).toBeNull();
    expect(livePaneComposerCaveat("some-future-agent")).toBeNull();
    expect(supportsLivePaneCapability("some-future-agent", "feedback")).toBe(false);
  });

  test("Codex and OpenCode cannot source a transcript, each for its own stated reason", () => {
    expect(livePaneAgentProfile("codex").transcriptSource).toBeNull();
    expect(livePaneCapabilityReason("codex", "transcript")).toContain("thread id");
    expect(livePaneAgentProfile("opencode").transcriptSource).toBeNull();
    expect(livePaneCapabilityReason("opencode", "transcript")).toContain("inside the agent");
  });

  test("an unknown agent kind promises nothing and is still labelled legibly", () => {
    const profile = livePaneAgentProfile("some-future-agent");
    expect(profile.label).toBe("Some Future Agent");
    expect(profile.transcriptSource).toBeNull();
    expect(livePaneLimitations("some-future-agent").map((limitation) => limitation.id))
      .toEqual([...LIVE_PANE_CAPABILITIES]);
  });

  test("missing or blank agent kinds degrade instead of throwing", () => {
    for (const agent of [undefined, null, "", "   "]) {
      expect(livePaneAgentLabel(agent)).toBe("Unknown agent");
      expect(supportsLivePaneCapability(agent, "feedback")).toBe(false);
    }
  });

  test("agent kinds are matched case-insensitively", () => {
    expect(livePaneAgentProfile("CLAUDE").label).toBe("Claude Code");
    expect(livePaneAgentProfile(" Pi ").transcriptSource).toBe("pi-extension");
  });

  test("every declared reason is a full sentence naming the agent or the mechanism", () => {
    // These strings are rendered verbatim to users; a bare "unavailable" would
    // put us straight back to an unexplained empty pane.
    for (const agent of ["claude", "codex", "opencode", "some-future-agent"]) {
      for (const limitation of livePaneLimitations(agent)) {
        expect(limitation.reason.length).toBeGreaterThan(40);
        expect(limitation.reason.endsWith(".")).toBe(true);
        expect(limitation.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("livePaneSendCopy", () => {
  test("an extension kind is described as queued, and never as delivered", () => {
    const copy = livePaneSendCopy("pi");
    expect(copy.mechanism).toBe("pi-extension");
    expect(copy.caveat).toBeNull();
    expect(copy.unavailableReason).toBeNull();
    // The host hands the text to a queue only the matching extension can claim,
    // and that claim is never reported back to a browser. "Queued" is the
    // strongest true word available.
    expect(copy.note.toLowerCase()).toContain("queued");
    expect(copy.note.toLowerCase()).not.toContain("received");
  });

  test("a composer kind names the mechanism and carries the registry's full caveat", () => {
    for (const agent of ["claude", "codex", "opencode"]) {
      const copy = livePaneSendCopy(agent);
      expect(copy.mechanism).toBe("herdr-composer");
      expect(copy.unavailableReason).toBeNull();
      // "through Herdr" earns its place in the short line: it is the reason the
      // guarantee is weaker than the extension path's.
      expect(copy.note).toContain("composer");
      expect(copy.note).toContain("Herdr");
      expect(copy.caveat).toBe(livePaneComposerCaveat(agent));
    }
  });

  test("a kind with no mechanism offers nothing and explains itself in the registry's words", () => {
    const copy = livePaneSendCopy("some-future-agent");
    expect(copy.mechanism).toBeNull();
    expect(copy.caveat).toBeNull();
    expect(copy.note).toBe("");
    expect(copy.unavailableReason).toBe(livePaneCapabilityReason("some-future-agent", "feedback"));
  });

  test("the pre-typing refusal reasons are browser-safe and say what a captain should do", () => {
    // Both are now rendered by a browser surface that refuses WITHOUT issuing a
    // request, as well as returned by the host on a 409. One copy, so the two
    // cannot drift into disagreeing about what happened.
    expect(COMPOSER_BUSY_REASON).toContain("mid-turn");
    expect(COMPOSER_BUSY_REASON).toContain("send it twice");
    expect(COMPOSER_UNREADABLE_REASON).toContain("could not read this pane's agent state");
  });
});
