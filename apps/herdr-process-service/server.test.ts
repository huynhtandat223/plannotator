import { describe, expect, test } from "bun:test";
import {
  feedbackBatch,
  panelsFromSnapshot,
  releasePanelSession,
  reviewSnapshotFromPanels,
  type HerdrPanel,
  type PanelSessionEnrichment,
} from "./server";

describe("feedbackBatch", () => {
  test("attributes code-only feedback to the selected structured live response", () => {
    const messages = [{
      messageId: "w:p1:pi-message-1",
      paneId: "w:p1",
      assistantMessageId: "pi-message-1",
      text: "Structured response",
      label: "Response 1 · latest",
      description: "Structured Pi assistant response",
      paneLabel: "one",
      paneDescription: "Pane p1",
      agentStatus: "working" as const,
      cwd: "/one",
    }];

    expect(feedbackBatch({
      annotations: [],
      codeAnnotations: [{ id: "code-1", filePath: "src/app.ts", lineStart: 12, text: "Use a safer boundary." }],
      selectedMessageId: "w:p1:pi-message-1",
    }, messages)).toEqual({
      paneId: "w:p1",
      batch: expect.objectContaining({
        messages: [expect.objectContaining({
          messageId: "pi-message-1",
          annotations: [],
          codeAnnotations: [{ id: "code-1", filePath: "src/app.ts", lineStart: 12, text: "Use a safer boundary." }],
        })],
      }),
    });
  });
});

describe("panelsFromSnapshot", () => {
  test("lists only live Pi agents with Herdr workspace and tab labels", () => {
    expect(panelsFromSnapshot({
      workspaces: [{ workspace_id: "workspace-1", label: "pi-harness" }],
      tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1", label: "plannotator" }],
      agents: [
        {
          agent: "pi",
          agent_status: "working",
          foreground_cwd: "/home/me/codes/pi-harness",
          pane_id: "workspace-1:p9",
          tab_id: "tab-1",
          workspace_id: "workspace-1",
          focused: true,
        },
        {
          agent: "claude",
          agent_status: "working",
          cwd: "/home/me/codes/other",
          pane_id: "workspace-1:p10",
        },
      ],
    })).toEqual([{
      id: "workspace-1:p9",
      workspace: "pi-harness",
      tab: "plannotator",
      panel: "Pane p9",
      cwd: "/home/me/codes/pi-harness",
      status: "working",
      focused: true,
    }]);
  });

  test("uses stable fallbacks when Herdr has no resource labels", () => {
    expect(panelsFromSnapshot({
      agents: [{ agent: "pi", agent_status: "idle", cwd: "/work/repo", pane_id: "w:p1" }],
    })).toEqual([{
      id: "w:p1",
      workspace: "repo",
      tab: "",
      panel: "Pane p1",
      cwd: "/work/repo",
      status: "idle",
      focused: false,
    }]);
  });

  test("renders each pane's structured response history newest-first while retaining pane and Pi message identities", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
      { id: "w:p2", workspace: "two", tab: "", panel: "Pane p2", cwd: "/two", status: "idle", focused: false },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "session-1", messages: [
        { messageId: "pi-message-1", text: "Newest response", timestamp: "2026-07-18T00:00:00.000Z" },
        { messageId: "pi-message-0", text: "Older response" },
      ] }],
      ["w:p2", { paneId: "w:p2", sessionId: "session-2", messages: [{ messageId: "pi-message-2", text: "Second pane response" }] }],
    ]);

    const snapshot = reviewSnapshotFromPanels(panels, "w:p2", enrichments);
    expect(snapshot.selectedMessageId).toBe("w:p2:pi-message-2");
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        messageId: "w:p1:pi-message-1",
        paneId: "w:p1",
        piSessionId: "session-1",
        assistantMessageId: "pi-message-1",
        text: "Newest response",
        timestamp: "2026-07-18T00:00:00.000Z",
        label: "Response 1 · latest",
        paneLabel: "one",
      }),
      expect.objectContaining({
        messageId: "w:p1:pi-message-0",
        paneId: "w:p1",
        assistantMessageId: "pi-message-0",
        text: "Older response",
        label: "Response 2",
        paneLabel: "one",
      }),
      expect.objectContaining({
        messageId: "w:p2:pi-message-2",
        paneId: "w:p2",
        piSessionId: "session-2",
        assistantMessageId: "pi-message-2",
        text: "Second pane response",
        paneLabel: "two",
      }),
    ]);
  });

  test("selects the newest response in the focused pane by default", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "session", messages: [
        { messageId: "newest", text: "Newest" },
        { messageId: "older", text: "Older" },
      ] }],
    ]);

    expect(reviewSnapshotFromPanels(panels, null, enrichments).selectedMessageId).toBe("w:p1:newest");
  });

  test("shows a truthful waiting document until the Pi extension enriches a live pane", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];

    const snapshot = reviewSnapshotFromPanels(panels);
    expect(snapshot.selectedMessageId).toBe("w:p1:waiting");
    expect(snapshot.messages[0].text).toContain("Waiting for the Pi session");
  });

  test("keeps a live user pane selection across assistant message changes", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
      { id: "w:p2", workspace: "two", tab: "", panel: "Pane p2", cwd: "/two", status: "idle", focused: false },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p2", { paneId: "w:p2", sessionId: "session-2", messages: [{ messageId: "new-message", text: "New response" }] }],
    ]);

    expect(reviewSnapshotFromPanels(panels, "w:p2", enrichments).selectedMessageId).toBe("w:p2:new-message");
  });

  test("falls back when the remembered panel is no longer live", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];

    expect(reviewSnapshotFromPanels(panels, "w:p2").selectedMessageId).toBe("w:p1:waiting");
  });

  test("does not let a shutting-down previous session remove a newer pane registration", () => {
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "new-session", messages: [{ messageId: "message", text: "Newest response" }] }],
    ]);

    expect(releasePanelSession(enrichments, "w:p1", "old-session")).toBe(false);
    expect(enrichments.get("w:p1")?.sessionId).toBe("new-session");
    expect(releasePanelSession(enrichments, "w:p1", "new-session")).toBe(true);
    expect(enrichments.has("w:p1")).toBe(false);
  });
});
