import { describe, expect, test } from "bun:test";
import {
  LIVE_PANE_CAPABILITIES,
  livePaneAgentLabel,
  livePaneAgentProfile,
  livePaneCapabilityReason,
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
      "feedback",
      "handoff",
    ]);
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
