import { describe, expect, test } from "bun:test";
import {
  LIVE_PANE_CAPABILITIES,
  livePaneAgentLabel,
  livePaneAgentProfile,
  livePaneCapabilityReason,
  livePaneComposerCaveat,
  livePaneFeedbackDelivery,
  livePaneLimitations,
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
